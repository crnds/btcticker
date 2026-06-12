package com.btcticker.app;

import android.content.Context;
import android.widget.RemoteViews;

public class PriceWidgetProvider extends BaseWidgetProvider {

    static final String ACTION_REFRESH        = "com.btcticker.app.PRICE_WIDGET_REFRESH";
    static final String ACTION_MANUAL_REFRESH = "com.btcticker.app.PRICE_WIDGET_MANUAL_REFRESH";

    @Override protected String actionRefresh()       { return ACTION_REFRESH; }
    @Override protected String actionManualRefresh() { return ACTION_MANUAL_REFRESH; }
    @Override protected long   intervalMs()          { return 10 * 60 * 1000L; }
    @Override protected int    requestCodeBase()     { return 10; }

    @Override
    protected RemoteViews buildPlaceholder(Context ctx, boolean manual) {
        if (!manual) return null;
        // keep the cached price visible; only the time label signals the fetch
        RemoteViews v = buildViews(ctx, BinanceApi.cached(ctx));
        v.setTextViewText(R.id.widget_time, "fetching…");
        return v;
    }

    @Override
    protected RemoteViews buildUpdate(Context ctx, boolean manual) {
        return buildViews(ctx, BinanceApi.fetchOrCached(ctx, manual ? 0 : 60_000));
    }

    private RemoteViews buildViews(Context ctx, BinanceApi.Ticker t) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_price);
        v.setTextViewText(R.id.widget_price,  t.price);
        v.setTextViewText(R.id.widget_change, t.change);
        v.setTextColor(R.id.widget_change, t.changeVal >= 0 ? COLOR_UP : COLOR_DOWN);
        v.setTextViewText(R.id.widget_time, t.updatedAt > 0 ? timeAgo(t.updatedAt) : "");
        v.setOnClickPendingIntent(R.id.widget_refresh_btn, manualRefreshIntent(ctx));
        return v;
    }
}
