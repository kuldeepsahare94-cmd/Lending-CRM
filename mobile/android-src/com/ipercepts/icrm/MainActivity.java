package com.ipercepts.icrm;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // iCRM's own plugin: the phone's call history and call recordings
        registerPlugin(CallLogPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
