package com.btcticker.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;

/** BTCUSDT 24h ticker from Binance, cached in shared prefs for all price widgets. */
final class BinanceApi {

    static final String PREFS = "btc_price_widget";
    private static final String URL_24H =
        "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT";

    static class Ticker {
        String price  = "—";
        String change = "";
        float  changeVal;
        long   updatedAt;
    }

    private BinanceApi() {}

    /**
     * Fetch fresh data unless the cache is younger than maxAgeMs (0 = always
     * fetch); falls back to the cached value on any failure. The cache window
     * dedupes fetches when several widget families update together.
     */
    static Ticker fetchOrCached(Context ctx, long maxAgeMs) {
        if (maxAgeMs > 0) {
            Ticker c = cached(ctx);
            if (c.updatedAt > 0 && System.currentTimeMillis() - c.updatedAt <= maxAgeMs) return c;
        }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(URL_24H).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("Accept", "application/json");

            JSONObject json = new JSONObject(Http.readBody(conn));
            double p = Double.parseDouble(json.getString("lastPrice"));
            double c = Double.parseDouble(json.getString("priceChangePercent"));

            Ticker t = new Ticker();
            t.price     = BaseWidgetProvider.fmtPrice(p);
            t.changeVal = (float) c;
            t.change    = (c >= 0 ? "+" : "") + Math.round(c) + "%";
            t.updatedAt = System.currentTimeMillis();

            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("price",     t.price)
                .putString("change",    t.change)
                .putFloat("change_val", t.changeVal)
                .putLong("last_update", t.updatedAt)
                .apply();
            return t;
        } catch (Exception e) {
            Log.w(BaseWidgetProvider.TAG, "Binance fetch failed", e);
            return cached(ctx);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static Ticker cached(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Ticker t = new Ticker();
        t.price     = prefs.getString("price",  "—");
        t.change    = prefs.getString("change", "");
        t.changeVal = prefs.getFloat("change_val", 0f);
        t.updatedAt = prefs.getLong("last_update", 0);
        return t;
    }
}
