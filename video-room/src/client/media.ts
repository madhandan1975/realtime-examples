import type {
  RoomSnapshot,
  SessionDescription,
  TrackReference,
} from "../shared/protocol";
import { ApiError, RoomApi } from "./api";
import { SerialMutationQueue } from "./mutation-queue";

type RemoteTrackHandler = (
  reference: TrackReference,
  track: MediaStreamTrack,
) => void;

export class MediaSessions {
  private readonly abortController = new AbortController();
  private readonly consumer = createPeerConnection();
  private readonly consumerQueue = new SerialMutationQueue(retryDecision);
  private readonly disconnectedTimers = new Map<
    RTCPeerConnection,
    ReturnType<typeof setTimeout>
  >();
  private readonly producer = createPeerConnection();
  private readonly producerQueue = new SerialMutationQueue(retryDecision);
  private readonly referencesByMid = new Map<string, TrackReference>();
  private closed = false;
  private connectionLostNotified = false;
  private micTrack: MediaStreamTrack | null = null;
  private silentTrack: MediaStreamTrack | null = null;
  private silentContext: AudioContext | null = null;
  private onConnectionLost: () => void = () => undefined;

  constructor(
    private readonly api: RoomApi,
    private readonly generation: number,
    private readonly localStream: MediaStream,
    private readonly onRemoteTrack: RemoteTrackHandler,
    onConnectionLost: () => void,
  ) {
    this.onConnectionLost = () => {
      if (this.closed || this.connectionLostNotified) return;
      this.connectionLostNotified = true;
      onConnectionLost();
    };
    const notifyLost = () => this.onConnectionLost();
    this.consumer.addEventListener("track", (event) => {
      if (this.closed) return;
      const mid = event.transceiver.mid;
      const reference = mid ? this.referencesByMid.get(mid) : undefined;
      if (reference) this.onRemoteTrack(reference, event.track);
    });
    for (const peer of [this.producer, this.consumer]) {
      peer.addEventListener("connectionstatechange", () => {
        if (this.closed) return;
        // Let ICE recover brief blips; only replace after sustained loss / failed.
        if (peer.connectionState === "failed") notifyLost();
        const disconnectedTimer = this.disconnectedTimers.get(peer);
        if (peer.connectionState === "disconnected") {
          if (disconnectedTimer === undefined) {
            this.disconnectedTimers.set(
              peer,
              setTimeout(() => {
                if (!this.closed) notifyLost();
              }, DISCONNECT_GRACE_MS),
            );
          }
        } else if (disconnectedTimer !== undefined) {
          clearTimeout(disconnectedTimer);
          this.disconnectedTimers.delete(peer);
        }
      });
    }
  }

  /**
   * Mute without `track.enabled = false`. Disabled tracks stop RTP and Cloudflare
   * SFU garbage-collects the publication after ~30s, so unmute stays silent.
   * Replace the sender with a silent keepalive track instead.
   */
  setLocalAudioMuted(muted: boolean): void {
    if (this.closed) return;
    for (const sender of this.producer.getSenders()) {
      if (!sender.track || sender.track.kind !== "audio") continue;
      if (muted) {
        if (sender.track !== this.silentTrack) {
          this.micTrack = sender.track;
          // Keep the mic track object alive and enabled for meters / unmute.
          sender.track.enabled = true;
        }
        void sender.replaceTrack(this.ensureSilentTrack());
      } else {
        const mic =
          this.micTrack && this.micTrack.readyState === "live"
            ? this.micTrack
            : (this.localStream.getAudioTracks().find(
                (track) => track.readyState === "live",
              ) ?? null);
        if (!mic) {
          this.onConnectionLost();
          return;
        }
        mic.enabled = true;
        this.micTrack = mic;
        void sender.replaceTrack(mic);
      }
    }
  }

  async publish(): Promise<void> {
    const mutation = mutationId();
    let prepared:
      | {
          offer: SessionDescription;
          tracks: Array<{ kind: "audio" | "video"; mid: string }>;
        }
      | undefined;
    let response:
      | Awaited<ReturnType<RoomApi["publish"]>>
      | undefined;
    await this.producerQueue.enqueue(async () => {
      if (!prepared) {
        await waitForStable(this.producer);
        const transceivers = this.localStream.getTracks().map((track) => {
          if (track.kind === "audio") this.micTrack = track;
          return this.producer.addTransceiver(track, { direction: "sendonly" });
        });
        const offer = await this.producer.createOffer();
        await this.producer.setLocalDescription(offer);
        await waitForIceGathering(this.producer);
        prepared = {
          offer: description(this.producer.localDescription!, "offer"),
          tracks: transceivers.map((transceiver) => ({
            kind: transceiver.sender.track!.kind as "audio" | "video",
            mid: requiredMid(transceiver),
          })),
        };
      }
      response ??= await this.api.publish({
        generation: this.generation,
        mutationId: mutation,
        sessionDescription: prepared.offer,
        tracks: prepared.tracks,
      }, this.abortController.signal);
      if (!this.producer.remoteDescription) {
        await this.producer.setRemoteDescription(response.sessionDescription);
      }
      await waitForConnected(this.producer);
    });
  }

  async syncSubscriptions(snapshot: RoomSnapshot, selfId: string): Promise<void> {
    const desired = snapshot.participants
      .filter((participant) => participant.id !== selfId)
      .flatMap((participant) => participant.published)
      .map((track) => track.key)
      .sort();
    const mutation = mutationId();
    let response:
      | Awaited<ReturnType<RoomApi["subscribe"]>>
      | undefined;
    let answer: SessionDescription | undefined;
    await this.consumerQueue.enqueue(async () => {
      await waitForStable(this.consumer);
      // SFU rejects tracks/new when the consumer session is already down.
      if (this.consumer.remoteDescription) {
        await waitForConnected(this.consumer);
      }
      response ??= await this.api.subscribe(
        this.generation,
        mutation,
        desired,
        this.abortController.signal,
      );
      this.referencesByMid.clear();
      for (const subscription of response.subscriptions) {
        this.referencesByMid.set(subscription.mid, {
          key: subscription.key,
          kind: subscription.kind,
          participantId: subscription.participantId,
        });
      }
      if (!response.requiresImmediateRenegotiation) return;
      if (!answer) {
        await this.consumer.setRemoteDescription(response.sessionDescription);
        const localAnswer = await this.consumer.createAnswer();
        await this.consumer.setLocalDescription(localAnswer);
        await waitForIceGathering(this.consumer);
        answer = description(this.consumer.localDescription!, "answer");
      }
      await this.api.renegotiate(
        this.generation,
        mutation,
        answer,
        this.abortController.signal,
      );
      await waitForConnected(this.consumer);
    });
  }

  idle(): Promise<void> {
    return Promise.all([
      this.producerQueue.onIdle(),
      this.consumerQueue.onIdle(),
    ]).then(() => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.producerQueue.close();
    this.consumerQueue.close();
    this.abortController.abort(
      new DOMException("The media session was closed.", "AbortError"),
    );
    for (const timer of this.disconnectedTimers.values()) clearTimeout(timer);
    this.disconnectedTimers.clear();
    this.silentTrack?.stop();
    this.silentTrack = null;
    const silentContext = this.silentContext;
    this.silentContext = null;
    if (silentContext) void silentContext.close();
    this.producer.close();
    this.consumer.close();
  }

  private ensureSilentTrack(): MediaStreamTrack {
    if (this.silentTrack && this.silentTrack.readyState === "live") {
      return this.silentTrack;
    }
    const context = new AudioContext();
    this.silentContext = context;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    void context.resume();
    const track = destination.stream.getAudioTracks()[0];
    if (!track) {
      throw new Error("Failed to create a silent audio keepalive track.");
    }
    this.silentTrack = track;
    return track;
  }

  async closeAndWait(timeoutMs: number): Promise<void> {
    this.close();
    await Promise.race([this.idle(), delay(timeoutMs)]);
  }
}

/** Brief ICE `disconnected` often self-heals; avoid tearing the SFU session down. */
const DISCONNECT_GRACE_MS = 15_000;

function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    bundlePolicy: "max-bundle",
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  });
}

function description(
  value: RTCSessionDescriptionInit,
  type: SessionDescription["type"],
): SessionDescription {
  if (!value.sdp) throw new Error("The browser did not create SDP.");
  return { sdp: value.sdp, type };
}

function mutationId(): string {
  return `m_${crypto.randomUUID().replaceAll("-", "")}`;
}

function requiredMid(transceiver: RTCRtpTransceiver): string {
  if (transceiver.mid === null) {
    throw new Error("The browser did not assign a media section identifier.");
  }
  return transceiver.mid;
}

function retryDecision(error: unknown, attempt: number) {
  const retry =
    error instanceof ApiError && error.retryable && attempt < 2;
  return { delayMs: 250 * 2 ** attempt, retry };
}

async function waitForStable(peer: RTCPeerConnection): Promise<void> {
  if (peer.signalingState === "stable") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      peer.removeEventListener("signalingstatechange", changed);
      reject(new Error("WebRTC signaling did not return to stable."));
    }, 15_000);
    const changed = () => {
      if (peer.signalingState !== "stable") return;
      clearTimeout(timeout);
      peer.removeEventListener("signalingstatechange", changed);
      resolve();
    };
    peer.addEventListener("signalingstatechange", changed);
  });
}

/** SFU uses non-trickle SDP; wait until candidates are in localDescription. */
async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    }, 5_000);
    const changed = () => {
      if (peer.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    };
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

async function waitForConnected(peer: RTCPeerConnection): Promise<void> {
  if (peer.connectionState === "connected") return;
  if (
    peer.connectionState === "failed" ||
    peer.connectionState === "closed"
  ) {
    throw new ApiError(
      "peer_connection_failed",
      "PeerConnection is not connected.",
      true,
    );
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      peer.removeEventListener("connectionstatechange", changed);
      reject(
        new ApiError(
          "peer_connection_timeout",
          "PeerConnection did not become connected.",
          true,
        ),
      );
    }, 15_000);
    const changed = () => {
      const state = peer.connectionState;
      if (state === "connected") {
        clearTimeout(timeout);
        peer.removeEventListener("connectionstatechange", changed);
        resolve();
        return;
      }
      if (state === "failed" || state === "closed") {
        clearTimeout(timeout);
        peer.removeEventListener("connectionstatechange", changed);
        reject(
          new ApiError(
            "peer_connection_failed",
            "PeerConnection is not connected.",
            true,
          ),
        );
      }
    };
    peer.addEventListener("connectionstatechange", changed);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
