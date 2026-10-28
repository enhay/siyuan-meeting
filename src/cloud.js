"use strict";

const crypto = require("node:crypto");
const https = require("node:https");
const fs = require("node:fs");

const hash = (algorithm, value) => crypto.createHash(algorithm).update(value).digest("hex");
const hmac = (algorithm, key, value, encoding) => crypto.createHmac(algorithm, key).update(value).digest(encoding);
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function failure(message, fields = {}) {
  return Object.assign(new Error(message), { userMessage: message, ...fields });
}

// Hosts are selected by the adapters, never from a response or an audio URL.
function request({ hostname, path = "/", method = "POST", headers = {}, body, file, signal }) {
  return new Promise((resolve, reject) => {
    let source;
    const req = https.request({ hostname, path, method, headers, signal, timeout: 120000 }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
          res.destroy(failure("云端返回内容过大，未覆盖已有转写", { code: "INVALID_RESPONSE" }));
        } else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(failure("云端连接等待超时，请稍后继续原任务", { code: "ETIMEDOUT" })));
    req.on("error", (error) => {
      source?.destroy();
      reject(error.userMessage ? error : failure("云端连接中断，请检查网络后继续原任务", { code: error.code || "NETWORK_ERROR" }));
    });
    if (file) {
      source = fs.createReadStream(file);
      source.on("error", (error) => req.destroy(error));
      source.pipe(req);
    } else req.end(body);
  });
}

function json(response) {
  try { return JSON.parse(response.text); }
  catch { throw failure("云端返回格式异常，未覆盖已有转写", { code: "INVALID_RESPONSE", httpStatus: response.status }); }
}

function tcHeaders(config, service, version, action, body, now = Math.floor(Date.now() / 1000)) {
  const host = `${service}.tencentcloudapi.com`;
  const date = new Date(now * 1000).toISOString().slice(0, 10);
  const scope = `${date}/${service}/tc3_request`;
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n\ncontent-type;host;x-tc-action\n${hash("sha256", body)}`;
  const string = `TC3-HMAC-SHA256\n${now}\n${scope}\n${hash("sha256", canonical)}`;
  const key = hmac("sha256", hmac("sha256", hmac("sha256", `TC3${config.secretKey}`, date), service), "tc3_request");
  return {
    "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body),
    "X-TC-Action": action, "X-TC-Version": version, "X-TC-Timestamp": String(now),
    Authorization: `TC3-HMAC-SHA256 Credential=${config.secretId}/${scope}, SignedHeaders=content-type;host;x-tc-action, Signature=${hmac("sha256", key, string, "hex")}`,
  };
}

async function tcCall(config, service, version, action, payload, signal) {
  const body = JSON.stringify(payload);
  const response = await request({ hostname: `${service}.tencentcloudapi.com`,
    headers: tcHeaders(config, service, version, action, body), body, signal });
  const result = json(response)?.Response;
  if (!result || response.status !== 200 || result.Error) {
    const code = result?.Error?.Code || "INVALID_RESPONSE";
    const auth = /AuthFailure|UnauthorizedOperation/.test(code);
    throw failure(auth ? "腾讯云鉴权或权限不足，请检查密钥及所需服务权限"
      : "腾讯云未能完成请求，请检查服务开通、额度和任务状态", {
      code, requestId: result?.RequestId, httpStatus: response.status, rejected: Boolean(result?.Error),
    });
  }
  return result;
}

function parseCosEndpoint(value) {
  try {
    const input = String(value || "").trim();
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    const match = /^([a-z0-9][a-z0-9-]*-\d+)\.cos\.([a-z]{2}-[a-z]+(?:-\d+)?)\.myqcloud\.com$/.exec(url.hostname);
    if (!match || url.protocol !== "https:" || url.port || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) throw new Error("invalid endpoint");
    return { bucket: match[1], region: match[2] };
  } catch {
    throw failure("请填写 COS 控制台中的存储桶默认域名，例如 https://meeting-1250000000.cos.ap-shanghai.myqcloud.com");
  }
}

function cosHost({ bucket, region }) {
  if (!/^[a-z0-9][a-z0-9-]*-\d+$/.test(bucket || "") || !/^[a-z]{2}-[a-z]+(?:-\d+)?$/.test(region || "")) {
    throw failure("COS 存储桶地址无效，请检查设置");
  }
  return `${bucket}.cos.${region}.myqcloud.com`;
}

function cosSignature(config, method, key, headers = {}, seconds = 3600, now = Math.floor(Date.now() / 1000)) {
  if (!/^siyuan-meeting\/[a-f0-9-]+\/\d+\.wav$/.test(key)) throw failure("云端录音路径无效，已停止操作");
  if (!/^[A-Za-z0-9_-]+$/.test(config.secretId || "") || !config.secretKey) throw failure("请先配置 COS 密钥");
  const time = `${now - 60};${now + seconds}`;
  const signed = { host: cosHost(config), ...headers };
  const names = Object.keys(signed).sort();
  const headerString = names.map((name) => `${encode(name)}=${encode(String(signed[name]))}`).join("&");
  const httpString = `${method.toLowerCase()}\n/${key}\n\n${headerString}\n`;
  const signKey = hmac("sha1", config.secretKey, time, "hex");
  const signature = hmac("sha1", signKey, `sha1\n${time}\n${hash("sha1", httpString)}\n`, "hex");
  return `q-sign-algorithm=sha1&q-ak=${encode(config.secretId)}&q-sign-time=${time}&q-key-time=${time}&q-header-list=${names.join(";")}&q-url-param-list=&q-signature=${signature}`;
}

async function upload(config, key, file, signal) {
  const headers = { "content-type": "audio/wav", "content-length": fs.statSync(file).size, "x-cos-acl": "private" };
  const response = await request({ hostname: cosHost(config), path: `/${key}`, method: "PUT",
    headers: { ...headers, Authorization: cosSignature(config, "PUT", key, headers) }, file, signal });
  if (response.status !== 200) throw failure("录音上传 COS 失败，请检查桶、地域及写入权限", { httpStatus: response.status });
}

function downloadUrl(config, key) {
  // Covers provider download/queue time; COS objects are deleted after the saved result.
  const query = new URLSearchParams(cosSignature(config, "GET", key, {}, 24 * 3600)).toString();
  return `https://${cosHost(config)}/${key}?${query}`;
}

async function remove(config, key, signal) {
  const response = await request({ hostname: cosHost(config), path: `/${key}`, method: "DELETE",
    headers: { Authorization: cosSignature(config, "DELETE", key) }, signal });
  if (![204, 404].includes(response.status)) throw failure("COS 临时录音尚未删除，请检查删除权限后重试清理", { httpStatus: response.status });
}

module.exports = { request, json, failure, tcHeaders, tcCall, parseCosEndpoint, cosHost, cosSignature, upload, downloadUrl, remove };
