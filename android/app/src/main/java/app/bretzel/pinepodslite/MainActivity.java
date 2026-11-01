package app.bretzel.pinepodslite;

import android.os.Bundle;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import app.bretzel.pinepodslite.downloads.NativeDownloadsPlugin;
import app.bretzel.pinepodslite.player.NativePlayerPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App plugins must be registered before the bridge starts in super.onCreate.
        registerPlugin(NativePlayerPlugin.class);
        registerPlugin(NativeDownloadsPlugin.class);
        super.onCreate(savedInstanceState);
        // Route service-worker requests through Capacitor's local server.
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return bridge.getLocalServer().shouldInterceptRequest(request);
            }
        });
    }
}
