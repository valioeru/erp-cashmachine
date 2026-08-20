"use strict";

const { URL } = require("url");
const querystring = require("querystring");

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const paramNames = [];
    const regexStr = pattern
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          paramNames.push(seg.slice(1));
          return "([^/]+)";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    const regex = new RegExp(`^${regexStr}$`);
    this.routes.push({ method: method.toUpperCase(), regex, paramNames, handler });
  }

  get(pattern, handler) {
    this.add("GET", pattern, handler);
  }
  post(pattern, handler) {
    this.add("POST", pattern, handler);
  }

  async handle(req, res) {
    const parsed = new URL(req.url, "http://localhost");
    const pathname = decodeURIComponent(parsed.pathname).replace(/\/+$/, "") || "/";
    const query = Object.fromEntries(parsed.searchParams.entries());

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const m = pathname.match(route.regex);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, i) => (params[name] = m[i + 1]));

      let body = {};
      if (req.method === "POST") {
        body = await parseBody(req);
      }

      const ctx = { req, res, params, query, body, user: req.utilizator || null };
      try {
        await route.handler(ctx);
      } catch (err) {
        console.error(err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Eroare server: " + err.message);
        }
      }
      return true;
    }
    return false;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 25_000_000) {
        reject(new Error("Body prea mare"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks);
        const contentType = req.headers["content-type"] || "";
        if (contentType.startsWith("multipart/form-data")) {
          resolve(parseMultipart(buffer, contentType));
        } else {
          resolve(querystring.parse(buffer.toString("utf8")));
        }
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Parser minimal pentru multipart/form-data (upload de fișiere), fără nicio
// dependință externă. Câmpurile text ajung ca proprietăți normale în body
// (ex: ctx.body.directie), iar fișierele ajung în ctx.body.__files, cheia
// fiind numele câmpului din formular (ex: ctx.body.__files.fisier[0].data).
function parseMultipart(buffer, contentType) {
  const result = { __files: {} };
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = m ? (m[1] || m[2]).trim() : null;
  if (!boundary) return result;

  const delim = Buffer.from(`--${boundary}`);
  const indices = [];
  let pos = 0;
  while (true) {
    const idx = buffer.indexOf(delim, pos);
    if (idx === -1) break;
    indices.push(idx);
    pos = idx + delim.length;
  }

  for (let i = 0; i < indices.length - 1; i++) {
    let part = buffer.slice(indices[i] + delim.length, indices[i + 1]);
    if (part.slice(0, 2).toString("latin1") === "\r\n") part = part.slice(2);
    if (part.slice(-2).toString("latin1") === "\r\n") part = part.slice(0, -2);
    if (part.length === 0) continue;

    const headerEndIdx = part.indexOf("\r\n\r\n");
    if (headerEndIdx === -1) continue;
    const headerStr = part.slice(0, headerEndIdx).toString("utf8");
    const bodyBuf = part.slice(headerEndIdx + 4);

    const nameMatch = /name="([^"]*)"/.exec(headerStr);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    const filenameMatch = /filename="([^"]*)"/.exec(headerStr);
    const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerStr);

    if (filenameMatch && filenameMatch[1]) {
      if (!result.__files[fieldName]) result.__files[fieldName] = [];
      result.__files[fieldName].push({
        filename: filenameMatch[1],
        contentType: ctMatch ? ctMatch[1].trim() : "application/octet-stream",
        data: bodyBuf,
      });
    } else {
      result[fieldName] = bodyBuf.toString("utf8");
    }
  }
  return result;
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, headers));
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

module.exports = { Router, send, redirect };
