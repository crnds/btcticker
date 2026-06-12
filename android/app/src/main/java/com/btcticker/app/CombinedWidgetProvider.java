package com.btcticker.app;

import android.content.Context;
import android.widget.RemoteViews;

import java.util.List;

public class CombinedWidgetProvider extends BaseWidgetProvider {

    static final String ACTION_REFRESH        = "com.btcticker.app.COMBINED_WIDGET_REFRESH";
    static final String ACTION_MANUAL_REFRESH = "com.btcticker.app.COMBINED_WIDGET_MANUAL_REFRESH";

    private static final long CDC_STALE_MS = 12 * 3600 * 1000L; // re-fetch CDC if > 12 h old

    @Override protected String actionRefresh()       { return ACTION_REFRESH; }
    @Override protected String actionManualRefresh() { return ACTION_MANUAL_REFRESH; }
    @Override protected long   intervalMs()          { return 10 * 60 * 1000L; }
    @Override protected int    requestCodeBase()     { return 50; }

    @Override
    protected RemoteViews buildPlaceholder(Context ctx, boolean manual) {
        if (manual) return null; // tap refresh updates in place, no wipe-flash
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_combined);
        v.setTextViewText(R.id.widget_combined_price, "—");
        v.setTextViewText(R.id.widget_combined_cdc_label, "CDC · –");
        v.setOnClickPendingIntent(R.id.widget_combined_refresh_btn, manualRefreshIntent(ctx));
        return v;
    }

    @Override
    protected RemoteViews buildUpdate(Context ctx, boolean manual) {
        BinanceApi.Ticker t = BinanceApi.fetchOrCached(ctx, manual ? 0 : 60_000);
        List<KrakenCdc.Block> blocks = KrakenCdc.fetchOrCached(ctx, CDC_STALE_MS);
        long cdcAt = KrakenCdc.lastUpdate(ctx);

        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_combined);
        v.setTextViewText(R.id.widget_combined_price,  t.price);
        v.setTextViewText(R.id.widget_combined_change, t.change);
        v.setTextColor(R.id.widget_combined_change, t.changeVal >= 0 ? COLOR_UP : COLOR_DOWN);
        if (blocks != null) {
            v.setImageViewBitmap(R.id.widget_combined_strip,
                KrakenCdc.renderStrip(ctx, blocks, 70, 40, 0f, 1f, 1f));
        }
        v.setTextViewText(R.id.widget_combined_cdc_label,
            "CDC · " + (cdcAt > 0 ? timeAgo(cdcAt) : "–"));
        v.setOnClickPendingIntent(R.id.widget_combined_refresh_btn, manualRefreshIntent(ctx));
        return v;
    }
}
