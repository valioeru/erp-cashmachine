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

      const ctx = { req, res, params, query, body };
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
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) {
        reject(new Error("Body prea mare"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(querystring.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
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
