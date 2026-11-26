package com.booksnap.scanner;

import android.Manifest;
import android.content.Context;
import android.app.ActivityManager;
import android.content.pm.ActivityInfo;
import android.os.StatFs;
import android.hardware.display.DisplayManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Size;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.core.resolutionselector.AspectRatioStrategy;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.common.util.concurrent.ListenableFuture;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * The phone's real camera (CameraX — the same system camera apps use):
 * smooth native preview behind the (transparent) web page, continuous
 * autofocus, tap-to-focus, torch, and full-quality photos saved as JPEG.
 * Small preview frames are sent to the page for the page outline / PC live view.
 */
@CapacitorPlugin(name = "NativeCamera", permissions = {
        @Permission(strings = {Manifest.permission.CAMERA}, alias = "camera")
})
public class NativeCameraPlugin extends Plugin {
    private PreviewView previewView;
    private ProcessCameraProvider provider;
    private Camera camera;
    private ImageCapture imageCapture;
    private Preview preview;
    private ImageAnalysis analysis;          // small frames straight from the camera, off the screen thread
    private volatile long lastFrameAt = 0;
    private DisplayManager.DisplayListener displayListener;
    private final ExecutorService exec = Executors.newSingleThreadExecutor();        // preview frames
    private final ExecutorService photoExec = Executors.newSingleThreadExecutor();   // photos never wait behind frames
    private final java.util.concurrent.atomic.AtomicBoolean frameBusy = new java.util.concurrent.atomic.AtomicBoolean(false);
    private volatile boolean running = false;
    private int frameInterval = 200;
    private int frameSize = 720;
    private int captureWidth = 4640;
    private final Runnable frameTask = this::grabFrame;

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermission");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void cameraPermission(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) doStart(call);
        else call.reject("Camera permission was denied. Allow it in Settings → Apps → BookSnap → Permissions.");
    }

    private void doStart(PluginCall call) {
        frameInterval = Math.max(80, call.getInt("frameInterval", 200));
        frameSize = Math.max(240, call.getInt("frameSize", 720));
        captureWidth = Math.max(1600, Math.min(4640, call.getInt("captureWidth", 4640)));
        cleanupCache();
        getActivity().runOnUiThread(() -> {
            try {
                if (previewView == null) {
                    previewView = new PreviewView(getContext());
                    previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE); // TextureView: sits under the web page, supports getBitmap
                    previewView.setScaleType(PreviewView.ScaleType.FIT_CENTER);
                    previewView.setBackgroundColor(Color.BLACK);
                    WebView wv = getBridge().getWebView();
                    ViewGroup parent = (ViewGroup) wv.getParent();
                    parent.addView(previewView, 0, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                    parent.setBackgroundColor(Color.BLACK);          // around the picture: black, never the white window
                    wv.setBackgroundColor(Color.TRANSPARENT);
                }
                applyRect();
                ListenableFuture<ProcessCameraProvider> f = ProcessCameraProvider.getInstance(getContext());
                f.addListener(() -> {
                    try {
                        provider = f.get();
                        bind();
                        running = true;
                        previewView.removeCallbacks(frameTask);
                        if (analysis == null) previewView.postDelayed(frameTask, 400);   // fallback for old cameras
                        JSObject r = new JSObject();
                        r.put("torch", camera != null && camera.getCameraInfo().hasFlashUnit());
                        call.resolve(r);
                    } catch (Exception e) {
                        call.reject("Camera could not start: " + e.getMessage());
                    }
                }, ContextCompat.getMainExecutor(getContext()));
            } catch (Exception e) {
                call.reject("Camera could not start: " + e.getMessage());
            }
        });
    }

    private void bind() {
        provider.unbindAll();
        int rotation = previewView.getDisplay() != null ? previewView.getDisplay().getRotation() : getActivity().getWindowManager().getDefaultDisplay().getRotation();
        ResolutionSelector previewSel = new ResolutionSelector.Builder()
                .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                .build();
        // full quality, capped near 16 MP (plenty for pages; keeps 1000+ page books manageable)
        ResolutionSelector captureSel = new ResolutionSelector.Builder()
                .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                .setResolutionStrategy(new ResolutionStrategy(new Size(captureWidth, captureWidth * 3 / 4),
                        ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                .build();
        preview = new Preview.Builder().setResolutionSelector(previewSel).setTargetRotation(rotation).build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());
        imageCapture = new ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                .setResolutionSelector(captureSel)
                .setJpegQuality(90)
                .setTargetRotation(rotation)
                .build();
        LifecycleOwner owner = (LifecycleOwner) getActivity();
        try {
            analysis = new ImageAnalysis.Builder()
                    .setResolutionSelector(new ResolutionSelector.Builder()
                            .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                            .setResolutionStrategy(new ResolutionStrategy(new Size(640, 480),
                                    ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                            .build())
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                    .setTargetRotation(rotation)
                    .build();
            analysis.setAnalyzer(exec, this::analyze);
            camera = provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageCapture, analysis);
        } catch (Exception e) {
            // some older phones can't run 3 camera streams: preview + photo only, frames via the preview
            provider.unbindAll();
            analysis = null;
            camera = provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageCapture);
        }
        // keep preview + photos upright when the screen turns (portrait <-> landscape)
        if (displayListener == null) {
            displayListener = new DisplayManager.DisplayListener() {
                @Override public void onDisplayAdded(int id) {}
                @Override public void onDisplayRemoved(int id) {}
                @Override public void onDisplayChanged(int id) {
                    if (previewView == null || previewView.getDisplay() == null) return;
                    int r = previewView.getDisplay().getRotation();
                    if (preview != null) preview.setTargetRotation(r);
                    if (imageCapture != null) imageCapture.setTargetRotation(r);
                    if (analysis != null) analysis.setTargetRotation(r);
                }
            };
            ((DisplayManager) getContext().getSystemService(Context.DISPLAY_SERVICE)).registerDisplayListener(displayListener, null);
        }
    }

    /** "portrait" | "landscape" | "auto": turns the scanner screen (and so the photos). */
    @PluginMethod
    public void setOrientation(PluginCall call) {
        String m = call.getString("mode", "auto");
        getActivity().runOnUiThread(() -> {
            int o = "landscape".equals(m) ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    : "portrait".equals(m) ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
            getActivity().setRequestedOrientation(o);
            call.resolve();
        });
    }

    /** Camera frame stream (background thread): upright small JPEG a few times a second. */
    private void analyze(ImageProxy img) {
        try {
            long now = SystemClock.uptimeMillis();
            if (!running || now - lastFrameAt < frameInterval) return;
            lastFrameAt = now;
            Bitmap b = img.toBitmap();
            int rot = img.getImageInfo().getRotationDegrees();
            float s = Math.min(1f, (float) frameSize / Math.max(b.getWidth(), b.getHeight()));
            Matrix m = new Matrix();
            m.postScale(s, s);
            m.postRotate(rot);
            Bitmap sm = Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), m, true);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            sm.compress(Bitmap.CompressFormat.JPEG, 65, out);
            JSObject o = new JSObject();
            o.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            o.put("w", sm.getWidth());
            o.put("h", sm.getHeight());
            sm.recycle();
            b.recycle();
            notifyListeners("frame", o);
        } catch (Exception ignored) {
        } finally {
            img.close();
        }
    }

    /** Fallback: small JPEG of what the preview shows (for page outline, motion, PC live view). */
    private void grabFrame() {
        if (!running || previewView == null) return;
        Bitmap b = null;
        // skip this frame if the previous one is still being prepared (no backlog = no lag)
        if (!frameBusy.get()) { try { b = previewView.getBitmap(); } catch (Exception ignored) {} }
        if (b != null) {
            frameBusy.set(true);
            final Bitmap full = b;
            exec.execute(() -> {
                try {
                    float s = Math.min(1f, (float) frameSize / Math.max(full.getWidth(), full.getHeight()));
                    Bitmap sm = s < 1f ? Bitmap.createScaledBitmap(full, Math.round(full.getWidth() * s), Math.round(full.getHeight() * s), true) : full;
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    sm.compress(Bitmap.CompressFormat.JPEG, 65, out);
                    JSObject o = new JSObject();
                    o.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                    o.put("w", sm.getWidth());
                    o.put("h", sm.getHeight());
                    if (sm != full) sm.recycle();
                    full.recycle();
                    notifyListeners("frame", o);
                } catch (Exception ignored) {
                } finally {
                    frameBusy.set(false);
                }
            });
        }
        if (running && previewView != null) previewView.postDelayed(frameTask, frameInterval);
    }

    @PluginMethod
    public void capture(PluginCall call) {
        if (imageCapture == null) { call.reject("Camera not started"); return; }
        File f = new File(getContext().getCacheDir(), "booksnap_cap_" + System.currentTimeMillis() + ".jpg");
        getActivity().runOnUiThread(() -> {
            if (previewView != null && previewView.getDisplay() != null) imageCapture.setTargetRotation(previewView.getDisplay().getRotation());
            imageCapture.takePicture(new ImageCapture.OutputFileOptions.Builder(f).build(), photoExec,
                    new ImageCapture.OnImageSavedCallback() {
                        @Override
                        public void onImageSaved(@NonNull ImageCapture.OutputFileResults r) {
                            JSObject o = new JSObject();
                            o.put("path", f.getAbsolutePath());
                            o.put("size", f.length());
                            call.resolve(o);
                        }
                        @Override
                        public void onError(@NonNull ImageCaptureException e) {
                            call.reject("Photo failed: " + e.getMessage());
                        }
                    });
        });
    }

    /** Phone memory and free storage, so the app can adapt to low-end phones. */
    @PluginMethod
    public void deviceInfo(PluginCall call) {
        JSObject o = new JSObject();
        try {
            ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            o.put("totalMem", mi.totalMem);
            o.put("availMem", mi.availMem);
            o.put("lowRam", am.isLowRamDevice());
            o.put("memoryClass", am.getLargeMemoryClass());
        } catch (Exception ignored) {}
        try {
            StatFs st = new StatFs(getContext().getFilesDir().getAbsolutePath());
            o.put("freeDisk", st.getAvailableBytes());
            o.put("totalDisk", st.getTotalBytes());
        } catch (Exception ignored) {}
        call.resolve(o);
    }

    @PluginMethod
    public void release(PluginCall call) {
        String p = call.getString("path");
        if (p != null) {
            // only our own photos in the app's cache folder
            File f = new File(p);
            try {
                if (f.getName().startsWith("booksnap_cap_") && getContext().getCacheDir().getCanonicalPath().equals(f.getCanonicalFile().getParent())) f.delete();
            } catch (java.io.IOException ignored) { }
        }
        call.resolve();
    }

    @PluginMethod
    public void focus(PluginCall call) {
        final float x = call.getFloat("x", 0.5f), y = call.getFloat("y", 0.5f);
        getActivity().runOnUiThread(() -> {
            try {
                if (camera == null || previewView == null) { call.resolve(); return; }
                MeteringPoint p = previewView.getMeteringPointFactory().createPoint(x * previewView.getWidth(), y * previewView.getHeight());
                camera.getCameraControl().startFocusAndMetering(
                        new FocusMeteringAction.Builder(p).setAutoCancelDuration(4, TimeUnit.SECONDS).build());
                call.resolve();
            } catch (Exception e) { call.resolve(); }
        });
    }

    @PluginMethod
    public void torch(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        if (camera != null) camera.getCameraControl().enableTorch(on);
        call.resolve();
    }

    // The camera picture only fills the area between the scanner's top and bottom bars (so the
    // buttons never cover it). Values are CSS pixels inside the web page.
    private float rectT = 0, rectL = 0, rectR = 0, rectB = 0;

    @PluginMethod
    public void setPreviewRect(PluginCall call) {
        rectT = Math.max(0, call.getFloat("top", 0f));
        rectL = Math.max(0, call.getFloat("left", 0f));
        rectR = Math.max(0, call.getFloat("right", 0f));
        rectB = Math.max(0, call.getFloat("bottom", 0f));
        getActivity().runOnUiThread(() -> { applyRect(); call.resolve(); });
    }

    private void applyRect() {
        if (previewView == null) return;
        try {
            WebView wv = getBridge().getWebView();
            ViewGroup parent = (ViewGroup) previewView.getParent();
            if (parent == null) return;
            float d = wv.getResources().getDisplayMetrics().density;
            int pw = parent.getWidth(), ph = parent.getHeight();
            int t = wv.getTop() + Math.round(rectT * d);
            int l = wv.getLeft() + Math.round(rectL * d);
            int r = (pw > 0 ? pw - wv.getRight() : 0) + Math.round(rectR * d);
            int b = (ph > 0 ? ph - wv.getBottom() : 0) + Math.round(rectB * d);
            ViewGroup.LayoutParams lp = previewView.getLayoutParams();
            if (lp instanceof ViewGroup.MarginLayoutParams) {
                ViewGroup.MarginLayoutParams m = (ViewGroup.MarginLayoutParams) lp;
                m.width = ViewGroup.LayoutParams.MATCH_PARENT; m.height = ViewGroup.LayoutParams.MATCH_PARENT;
                m.setMargins(l, t, r, b);
                previewView.setLayoutParams(m);
            }
        } catch (Exception ignored) {}
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running = false;
        getActivity().runOnUiThread(() -> {
            try { if (provider != null) provider.unbindAll(); } catch (Exception ignored) {}
            if (previewView != null) {
                previewView.removeCallbacks(frameTask);
                ViewGroup parent = (ViewGroup) previewView.getParent();
                if (parent != null) { parent.removeView(previewView); parent.setBackgroundColor(Color.TRANSPARENT); }
                previewView = null;
            }
            camera = null;
            imageCapture = null;
            preview = null;
            analysis = null;
            if (displayListener != null) {
                ((DisplayManager) getContext().getSystemService(Context.DISPLAY_SERVICE)).unregisterDisplayListener(displayListener);
                displayListener = null;
            }
            getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            getBridge().getWebView().setBackgroundColor(Color.WHITE);
            call.resolve();
        });
    }

    private void cleanupCache() {
        File[] old = getContext().getCacheDir().listFiles((d, n) -> n.startsWith("booksnap_cap_"));
        if (old != null) for (File o : old) o.delete();
    }
}
