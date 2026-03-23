const fs = require("fs");
const path = require("path");
const { URL } = require("url");

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, data, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function jsonResponse(status, data) {
  return { status, data };
}

function createStaticHandler({ publicDir }) {
  function getStaticFile(filePath) {
    const fullPath = path.normalize(path.join(publicDir, filePath));
    if (!fullPath.startsWith(publicDir)) {
      return null;
    }
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fullPath;
    }
    return null;
  }

  function serveStatic(req, res) {
    let pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/") {
      pathname = "/index.html";
    }
    const filePath = getStaticFile(pathname);
    if (!filePath) {
      return false;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentTypeMap = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    };
    sendText(res, 200, fs.readFileSync(filePath, "utf8"), contentTypeMap[ext] || "text/plain; charset=utf-8");
    return true;
  }

  return {
    serveStatic,
  };
}

module.exports = {
  createStaticHandler,
  jsonResponse,
  notFound,
  parseBody,
  sendJson,
  sendText,
};
