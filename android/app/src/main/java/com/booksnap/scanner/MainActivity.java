package com.booksnap.scanner;

import android.os.Bundle;
import android.view.KeyEvent;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShutterPlugin.class);
        registerPlugin(NativeCameraPlugin.class);
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        // keep the screen on while BookSnap is open (long scanning sessions)
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        boolean shutterKey = k == KeyEvent.KEYCODE_VOLUME_UP || k == KeyEvent.KEYCODE_VOLUME_DOWN
                || k == KeyEvent.KEYCODE_CAMERA || k == KeyEvent.KEYCODE_HEADSETHOOK
                || k == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE;
        if (ShutterPlugin.active && shutterKey) {
            if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) {
                ShutterPlugin.fire(KeyEvent.keyCodeToString(k));
            }
            return true;   // don't change the volume while scanning
        }
        return super.dispatchKeyEvent(e);
    }
}
