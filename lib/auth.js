const crypto = require("crypto");

const SESSION_COOKIE = "nocturne_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

function createAuthTools({ readJson, writeJson, authFile, username = "", password = "" }) {
  const sessions = new Map();

  function hashPassword(value, salt) {
    return crypto.scryptSync(String(value), salt, 64).toString("hex");
  }

  function createCredential(usernameValue, passwordValue) {
    const salt = crypto.randomBytes(16).toString("hex");
    return {
      username: String(usernameValue || "").trim(),
      salt,
      passwordHash: hashPassword(passwordValue, salt),
      createdAt: new Date().toISOString(),
    };
  }

  function loadCredential() {
    const stored = readJson(authFile);
    if (stored?.username && stored?.salt && stored?.passwordHash) {
      return stored;
    }
    if (!String(username || "").trim() || !String(password || "")) {
      return null;
    }
    const created = createCredential(username, password);
    writeJson(authFile, created);
    try {
      require("fs").chmodSync(authFile, 0o600);
    } catch {
      // Windows and filesystems without POSIX modes can ignore this hardening.
    }
    return created;
  }

  function getCredential() {
    return loadCredential();
  }

  function isEnabled() {
    return Boolean(getCredential());
  }

  function verify(usernameValue, passwordValue) {
    const credential = getCredential();
    if (!credential || String(usernameValue || "") !== credential.username) {
      return false;
    }
    const expected = Buffer.from(credential.passwordHash, "hex");
    const actual = Buffer.from(hashPassword(passwordValue, credential.salt), "hex");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  function parseCookies(req) {
    return Object.fromEntries(
      String(req.headers.cookie || "")
        .split(";")
        .map((part) => part.trim().split("="))
        .filter(([key, value]) => key && value)
        .map(([key, ...value]) => [key, decodeURIComponent(value.join("="))])
    );
  }

  function isAuthenticated(req) {
    if (!isEnabled()) {
      return true;
    }
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token || !sessions.has(token)) {
      return false;
    }
    const session = sessions.get(token);
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return false;
    }
    session.expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
    return true;
  }

  function setSessionCookie(res, token, maxAge = SESSION_MAX_AGE_SECONDS, secure = false) {
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`
    );
  }

  async function handleRoute(req, res, { parseBody, sendJson, pathname, secureCookie = false }) {
    if (!pathname.startsWith("/api/auth/")) {
      return false;
    }
    if (req.method === "GET" && pathname === "/api/auth/session") {
      sendJson(res, 200, { enabled: isEnabled(), authenticated: isAuthenticated(req) });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/auth/login") {
      if (!isEnabled()) {
        sendJson(res, 200, { ok: true, enabled: false, authenticated: true });
        return true;
      }
      const body = await parseBody(req);
      if (!verify(body.username, body.password)) {
        sendJson(res, 401, { error: "Invalid username or password" });
        return true;
      }
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 });
      setSessionCookie(res, token, SESSION_MAX_AGE_SECONDS, secureCookie);
      sendJson(res, 200, { ok: true, enabled: true, authenticated: true, username: getCredential().username });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/auth/logout") {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (token) {
        sessions.delete(token);
      }
      setSessionCookie(res, "", 0, secureCookie);
      sendJson(res, 200, { ok: true });
      return true;
    }
    sendJson(res, 404, { error: "Not found" });
    return true;
  }

  return {
    getCredential,
    handleRoute,
    isAuthenticated,
    isEnabled,
  };
}

module.exports = {
  createAuthTools,
};
