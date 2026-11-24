export type VoiceCallSessionStartOptions = {
  roomId: string;
  title?: string;
};

export interface VoiceCallSessionPlugin {
  /** Configure OS audio session / start foreground service for an active room. */
  start(options: VoiceCallSessionStartOptions): Promise<void>;
  /** Tear down background call session when leaving the room. */
  stop(): Promise<void>;
}
