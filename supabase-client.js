/**
 * Ace — Supabase JS v2 client (browser, no bundler)
 *
 * Load order (classic scripts, no type="module"):
 *   1. Supabase UMD build (see README / project docs for CDN URL)
 *   2. supabase-config.js
 *   3. supabase-client.js
 *
 * Exposes: window.aceSupabase (client or null)
 *          window.aceSupabaseInitError (null | string)
 *          window.aceSupabaseInitOk (boolean)
 */

(function (global) {
  "use strict";

  function reportInit(ok, errorCode) {
    global.aceSupabaseInitOk = ok;
    global.aceSupabaseInitError = errorCode || null;

    if (ok) {
      console.info(
        "[Ace] Supabase: initialization succeeded. " +
          "Use window.aceSupabase (credentials are not logged)."
      );
      return;
    }

    var messages = {
      missing_config:
        "[Ace] Supabase: initialization failed (missing_config). " +
        "Set window.ACE_SUPABASE_URL and window.ACE_SUPABASE_ANON_KEY " +
        "in supabase-config.js.",
      library_missing:
        "[Ace] Supabase: initialization failed (library_missing). " +
        "Load the @supabase/supabase-js v2 UMD script before " +
        "supabase-config.js and supabase-client.js.",
      create_client_failed:
        "[Ace] Supabase: initialization failed (create_client_failed). " +
        "Check that your URL and publishable key are valid."
    };

    var message =
      messages[errorCode] ||
      "[Ace] Supabase: initialization failed (" + errorCode + ").";

    if (errorCode === "missing_config") {
      console.warn(message);
    } else {
      console.error(message);
    }
  }

  if (global.aceSupabase) {
    reportInit(true, null);
    return;
  }

  var url =
    typeof global.ACE_SUPABASE_URL === "string"
      ? global.ACE_SUPABASE_URL.trim()
      : "";

  var anonKey =
    typeof global.ACE_SUPABASE_ANON_KEY === "string"
      ? global.ACE_SUPABASE_ANON_KEY.trim()
      : "";

  if (!url || !anonKey) {
    global.aceSupabase = null;
    reportInit(false, "missing_config");
    return;
  }

  var lib = global.supabase;

  if (!lib || typeof lib.createClient !== "function") {
    global.aceSupabase = null;
    reportInit(false, "library_missing");
    return;
  }

  console.log(
    "[Ace] Supabase: @supabase/supabase-js v2 UMD loaded (global supabase.createClient)."
  );

  console.log(
    "[Ace] Supabase: config loaded (window.ACE_SUPABASE_URL and " +
      "window.ACE_SUPABASE_ANON_KEY set; values not logged)."
  );

  try {
    global.aceSupabase = lib.createClient(url, anonKey);
    reportInit(true, null);
    runConnectivityCheck(global.aceSupabase);
  } catch (error) {
    global.aceSupabase = null;
    reportInit(false, "create_client_failed");

    if (error && error.message) {
      console.error("[Ace] Supabase createClient detail:", error.message);
    }
  }

  /**
   * TEMP: setup verification only — no tables or signed-in user required.
   * Safe to remove when Supabase Auth is wired into login/dashboard.
   */
  function runConnectivityCheck(client) {

    if (
      !client ||
      !client.auth ||
      typeof client.auth.getSession !== "function"
    ) {
      console.warn(
        "[Ace] Supabase: connectivity check skipped (auth API unavailable)."
      );
      return;
    }

    client.auth
      .getSession()
      .then(function (result) {

        if (result.error) {
          console.warn(
            "[Ace] Supabase: connectivity check failed:",
            result.error.message
          );
          global.aceSupabaseReachable = false;
          return;
        }

        global.aceSupabaseReachable = true;

        console.log(
          "[Ace] Supabase: connectivity check OK (auth.getSession; " +
            "no database tables or signed-in user required)."
        );
      })
      .catch(function (error) {
        global.aceSupabaseReachable = false;

        console.warn(
          "[Ace] Supabase: connectivity check failed:",
          error && error.message ? error.message : "unknown error"
        );
      });
  }
})(window);
