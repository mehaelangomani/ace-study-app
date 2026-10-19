/**
 * Ace — Supabase Auth helpers (uses window.aceSupabase only)
 */

(function (global) {
  "use strict";

  var cachedProfile = null;

  function getClient() {
    return global.aceSupabase || null;
  }

  function profileFromUser(user) {

    if (!user) {
      return null;
    }

    var meta = user.user_metadata || {};
    var name =
      meta.full_name ||
      meta.name ||
      (user.email ? user.email.split("@")[0] : "") ||
      "User";

    return {
      id: user.id,
      email: user.email || "",
      name: name
    };

  }

  function setCachedProfile(user) {
    cachedProfile = profileFromUser(user);
    return cachedProfile;
  }

  function profileRowFromUser(user) {

    if (!user || !user.id) {
      return null;
    }

    var meta = user.user_metadata || {};

    return {
      id: user.id,
      email: user.email || null,
      full_name:
        meta.full_name ||
        meta.name ||
        null
    };

  }

  /**
   * Upsert public.profiles when the user has an active session (RLS).
   * New signups are also covered by the DB trigger on auth.users.
   */
  async function syncPublicProfile(user, session) {

    var client = getClient();

    if (!client || !session || !user || !user.id) {
      return { error: null };
    }

    var row = profileRowFromUser(user);

    if (!row) {
      return { error: null };
    }

    return client
      .from("profiles")
      .upsert(row, { onConflict: "id" });

  }

  function getAuthErrorMessage(error) {

    if (!error) {
      return "";
    }

    if (typeof error === "string") {
      return error.trim();
    }

    return String(
      error.message ||
        error.msg ||
        error.error_description ||
        ""
    ).trim();

  }

  function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
  }

  function getEmailRedirectTo() {

    if (!global.location || !global.location.origin) {
      return undefined;
    }

    var path = String(global.location.pathname || "/");

    if (path.lastIndexOf("/") !== -1) {
      path = path.slice(0, path.lastIndexOf("/") + 1);
    } else {
      path = "/";
    }

    return global.location.origin + path + "login.html";

  }

  function formatAuthError(error) {

    if (!error) {
      return "Something went wrong. Please try again.";
    }

    var message = getAuthErrorMessage(error);
    var code = String(
      error.code || error.error_code || ""
    ).toLowerCase();
    var lower = message.toLowerCase();

    if (!message && code) {
      message = code.replace(/_/g, " ");
    }

    if (code === "email_address_invalid") {
      return (
        message ||
        "This email address is not accepted by Supabase Auth."
      );
    }

    if (code === "email_address_not_authorized") {
      return (
        message ||
        "This project cannot send auth emails to that address with the default SMTP."
      );
    }

    if (lower === "invalid login credentials") {
      return "Invalid email or password. Please try again.";
    }

    if (
      code === "email_not_confirmed" ||
      lower.includes("email not confirmed")
    ) {
      return (
        message ||
        "Please confirm your email before signing in."
      );
    }

    if (
      code === "email_exists" ||
      lower.includes("user already registered")
    ) {
      return (
        message ||
        "An account with this email already exists."
      ) +
        " Try signing in instead.";
    }

    if (lower.includes("password should be at least")) {
      return message || "Password must be at least 6 characters.";
    }

    if (code === "email_provider_disabled" || lower.includes("signup is disabled")) {
      return (
        message ||
        "Email sign-up is disabled for this project."
      );
    }

    if (
      code === "over_email_send_rate_limit" ||
      code === "over_request_rate_limit" ||
      lower.includes("email rate limit exceeded")
    ) {
      var rateCode = code || "over_email_send_rate_limit";
      var rateMessage = message || "email rate limit exceeded";

      return (
        "Too many signup email requests. Please wait before trying again." +
        " (" + rateCode + ": " + rateMessage + ")"
      );
    }

    if (lower.includes("rate limit") || lower.includes("too many requests")) {
      var genericCode = code || "rate_limit";
      var genericMessage = message || "rate limit exceeded";

      return (
        "Too many attempts. Please wait and try again." +
        " (" + genericCode + ": " + genericMessage + ")"
      );
    }

    if (code && message) {
      return code + ": " + message;
    }

    return message || "Something went wrong. Please try again.";

  }

  async function refreshProfile() {

    var client = getClient();

    if (!client) {
      cachedProfile = null;
      return null;
    }

    var result = await client.auth.getSession();

    if (result.error || !result.data.session) {
      cachedProfile = null;
      return null;
    }

    return setCachedProfile(result.data.session.user);

  }

  function refreshProfileFromSession(session) {

    if (!session || !session.user) {
      cachedProfile = null;
      return null;
    }

    return setCachedProfile(session.user);

  }

  async function requireDashboardSession() {

    var client = getClient();

    if (!client || !global.aceSupabaseInitOk) {
      global.location.href = "login.html";
      return false;
    }

    var result = await client.auth.getSession();

    if (result.error || !result.data.session) {
      global.location.href = "login.html";
      return false;
    }

    setCachedProfile(result.data.session.user);

    await syncPublicProfile(
      result.data.session.user,
      result.data.session
    );

    return true;

  }

  async function signInWithPassword(email, password) {

    var client = getClient();

    if (!client) {
      return {
        error: { message: "Supabase is not configured on this page." }
      };
    }

    var result = await client.auth.signInWithPassword({
      email: normalizeEmail(email),
      password: String(password || "")
    });

    if (
      !result.error &&
      result.data &&
      result.data.user &&
      result.data.session
    ) {
      await syncPublicProfile(result.data.user, result.data.session);
    }

    return result;

  }

  async function signUp(email, password, fullName) {

    var client = getClient();

    if (!client) {
      return {
        error: { message: "Supabase is not configured on this page." }
      };
    }

    var normalizedEmail = normalizeEmail(email);
    var redirectTo = getEmailRedirectTo();

    var signUpOptions = {
      data: {
        full_name: String(fullName || "").trim()
      }
    };

    if (redirectTo) {
      signUpOptions.emailRedirectTo = redirectTo;
    }

    var result = await client.auth.signUp({
      email: normalizedEmail,
      password: String(password || ""),
      options: signUpOptions
    });

    if (result.error) {
      return result;
    }

    var user = result.data && result.data.user;

    if (
      user &&
      Array.isArray(user.identities) &&
      user.identities.length === 0
    ) {
      return {
        data: result.data,
        error: {
          message: "An account with this email already exists.",
          code: "email_exists"
        }
      };
    }

    if (user) {
      await syncPublicProfile(user, result.data.session);
    }

    return result;

  }

  async function signOut() {

    var client = getClient();

    cachedProfile = null;

    if (!client) {
      return { error: null };
    }

    return client.auth.signOut();

  }

  async function updateProfile({ name, email, about }) {

    var client = getClient();

    if (!client) {
      return {
        error: { message: "Supabase is not available." }
      };
    }

    if (about !== undefined) {
      try {
        global.localStorage.setItem("aceProfileAbout", about);
      } catch (ignored) {}
    }

    var payload = {
      data: {
        full_name: name
      }
    };

    if (email) {
      payload.email = email;
    }

    var result = await client.auth.updateUser(payload);

    if (!result.error && result.data.user) {
      setCachedProfile(result.data.user);

      var sessionResult = await client.auth.getSession();

      if (sessionResult.data && sessionResult.data.session) {
        await syncPublicProfile(
          result.data.user,
          sessionResult.data.session
        );
      }

    }

    return result;

  }

  async function getAccessToken() {

    var client = getClient();

    if (!client) {
      return null;
    }

    var result = await client.auth.getSession();

    if (result.error || !result.data.session) {
      return null;
    }

    return result.data.session.access_token || null;

  }

  async function redirectIfAuthenticated(dashboardUrl) {

    var client = getClient();

    if (!client) {
      return false;
    }

    var result = await client.auth.getSession();

    if (result.data.session) {
      global.location.href = dashboardUrl || "dashboard.html";
      return true;
    }

    return false;

  }

  function listenAuthChanges(onProfileChange) {

    var client = getClient();

    if (!client || typeof onProfileChange !== "function") {
      return;
    }

    client.auth.onAuthStateChange(function (event, session) {

      refreshProfileFromSession(session);

      if (session && session.user) {
        syncPublicProfile(session.user, session);
      }

      if (
        event === "SIGNED_OUT" &&
        /dashboard\.html$/i.test(global.location.pathname)
      ) {
        global.location.href = "login.html";
        return;
      }

      onProfileChange(cachedProfile, event);

    });

  }

  global.AceAuth = {
    getProfile: function () {
      return cachedProfile;
    },
    refreshProfile: refreshProfile,
    refreshProfileFromSession: refreshProfileFromSession,
    requireDashboardSession: requireDashboardSession,
    signInWithPassword: signInWithPassword,
    signUp: signUp,
    signOut: signOut,
    updateProfile: updateProfile,
    syncPublicProfile: syncPublicProfile,
    formatAuthError: formatAuthError,
    normalizeEmail: normalizeEmail,
    getAccessToken: getAccessToken,
    redirectIfAuthenticated: redirectIfAuthenticated,
    listenAuthChanges: listenAuthChanges
  };

})(window);
