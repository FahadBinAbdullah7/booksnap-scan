package com.booksnap.scanner;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Lets hardware keys take a photo while the scanner is open:
 * volume buttons, the camera key, wired/Bluetooth headset buttons and
 * cheap Bluetooth "selfie" shutter remotes (they send VOLUME_UP).
 */
@CapacitorPlugin(name = "Shutter")
public class ShutterPlugin extends Plugin {
    static volatile boolean active = false;
    private static ShutterPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void setActive(PluginCall call) {
        active = Boolean.TRUE.equals(call.getBoolean("active", false));
        call.resolve();
    }

    static void fire(String key) {
        ShutterPlugin p = instance;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("key", key);
        p.notifyListeners("press", o);
    }
}
