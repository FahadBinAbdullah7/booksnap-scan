package com.booksnap.scanner;

import android.os.Bundle;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
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

        // Android's Back button works like the app's own ‹ button: the page closes an open window
        // or goes up one level (window.__appBack answers "yes"); on the home screen the app closes.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge() != null ? getBridge().getWebView() : null;
                if (wv == null) { exitApp(this); return; }
                wv.evaluateJavascript("(function(){try{return window.__appBack?window.__appBack():'no'}catch(e){return 'no'}})()", (v) -> {
                    if (v != null && v.contains("yes")) return;
                    exitApp(this);
                });
            }
        });
    }

    private void exitApp(OnBackPressedCallback cb) {
        cb.setEnabled(false);
        getOnBackPressedDispatcher().onBackPressed();
        cb.setEnabled(true);
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
