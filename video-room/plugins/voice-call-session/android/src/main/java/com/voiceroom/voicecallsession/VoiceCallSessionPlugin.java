package com.voiceroom.voicecallsession;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "VoiceCallSession",
    permissions = {
        @Permission(
            strings = { Manifest.permission.RECORD_AUDIO },
            alias = "microphone"
        ),
        @Permission(
            strings = { Manifest.permission.POST_NOTIFICATIONS },
            alias = "notifications"
        )
    }
)
public class VoiceCallSessionPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        String roomId = call.getString("roomId", "");
        String title = call.getString("title", "Voice Room");
        if (roomId == null || roomId.isEmpty()) {
            call.reject("roomId is required");
            return;
        }

        if (Build.VERSION.SDK_INT >= 33
            && getPermissionState("notifications") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermsCallback");
            return;
        }

        startForegroundService(roomId, title);
        call.resolve();
    }

    @PermissionCallback
    private void notificationPermsCallback(PluginCall call) {
        String roomId = call.getString("roomId", "");
        String title = call.getString("title", "Voice Room");
        startForegroundService(roomId, title);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), VoiceCallForegroundService.class);
        getContext().stopService(intent);
        call.resolve();
    }

    private void startForegroundService(String roomId, String title) {
        Intent intent = new Intent(getContext(), VoiceCallForegroundService.class);
        intent.putExtra(VoiceCallForegroundService.EXTRA_ROOM_ID, roomId);
        intent.putExtra(VoiceCallForegroundService.EXTRA_TITLE, title);
        ContextCompat.startForegroundService(getContext(), intent);
    }
}
