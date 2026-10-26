"use strict";

const { fetchSyncPost, openTab, getAllEditor } = require("siyuan");
const { parseIal, sqlString, escapeIal } = require("./util");

async function post(endpoint, payload = {}) {
  let response;
  try {
    response = await fetchSyncPost(endpoint.startsWith("/api/") ? endpoint : `/api/${endpoint}`, payload);
  } catch (error) {
    throw new Error(`思源请求失败：${error.message}`);
  }
  if (!response || response.code !== 0) {
    throw new Error(response?.msg || "思源未能完成此操作");
  }
  return response.data;
}

async function sql(stmt) {
  return (await post("/api/query/sql", { stmt })) || [];
}

function notebooks() {
  const list = window.siyuan?.notebooks || [];
  return list.filter((item) => !item.closed).map((item) => ({ id: item.id, name: item.name, icon: item.icon }));
}

function currentNotebookId() {
  try {
    const editors = getAllEditor();
    const notebookId = editors?.[0]?.protyle?.notebookId;
    if (notebookId) return notebookId;
  } catch {
    // get the fallback below
  }
  return notebooks()[0]?.id || "";
}

async function getBlockAttrs(id) {
  return (await post("/api/attr/getBlockAttrs", { id })) || {};
}

async function setBlockAttrs(id, attrs) {
  return post("/api/attr/setBlockAttrs", { id, attrs });
}

async function createDoc({ notebookId, title, parentID = "", markdown = "", id = "" }) {
  if (!notebookId) throw new Error("请先在思源中创建或打开一个笔记本");
  const safeTitle = String(title || "会议")
    .replace(/[\\/]/g, "／")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 180) || "会议";
  const parentPath = parentID ? await post("/api/filetree/getHPathByID", { id: parentID }) : "";
  const docPath = `${parentPath}/${safeTitle}`;
  const payload = {
    notebook: notebookId,
    path: docPath,
    markdown,
  };
  if (id) payload.id = id;
  try {
    return await post("/api/filetree/createDocWithMd", payload);
  } catch (error) {
    if (!/exist|already|重复|存在/i.test(error.message)) throw error;
    payload.path = `${docPath} (${new Date().toISOString().slice(11, 19).replaceAll(":", "")})`;
    return post("/api/filetree/createDocWithMd", payload);
  }
}

async function renameDoc(id, title) {
  const next = String(title || "").trim();
  if (!next) throw new Error("会议标题不能为空");
  await post("/api/filetree/renameDocByID", { id, title: next });
  return next;
}

async function getHPath(id) {
  const rows = await sql(`SELECT hpath FROM blocks WHERE id=${sqlString(id)} LIMIT 1`);
  return rows[0]?.hpath || "";
}

async function getDocMeta(id) {
  // createDocWithMd returns before the SQL index always catches up. Retry the
  // lookup briefly so a newly created meeting tab does not report a missing
  // document in the first few hundred milliseconds.
  for (let attempt = 0; attempt < 6; attempt++) {
    const rows = await sql(
      `SELECT id, content, box, hpath, path, created, updated FROM blocks WHERE id=${sqlString(id)} AND type='d' LIMIT 1`,
    );
    if (rows[0]) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

async function appendMarkdownRaw(parentID, data) {
  return post("/api/block/appendBlock", { parentID, dataType: "markdown", data });
}

async function prependMarkdownRaw(parentID, data) {
  return post("/api/block/prependBlock", { parentID, dataType: "markdown", data });
}

async function appendMarkdown(parentID, markdown, attrs = null) {
  const data = attrs
    ? `${markdown}\n{: ${Object.entries(attrs)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}="${escapeIal(value)}"`)
        .join(" ")}}\n`
    : markdown;
  return appendMarkdownRaw(parentID, data);
}

async function deleteBlocks(ids) {
  for (const id of ids) {
    try {
      await post("/api/block/deleteBlock", { id });
    } catch (error) {
      // A block deleted concurrently is not an error for our replacement flow.
      if (!/not found|不存在/i.test(error.message)) throw error;
    }
  }
}

async function getDocMarkdown(id) {
  const data = await post("/api/export/exportMdContent", { id, addTitle: false, yfm: false });
  return String(data?.content || "").replace(/\s+$/u, "");
}

async function resolveAssetPath(assetPath) {
  return post("/api/asset/resolveAssetPath", { path: assetPath });
}

async function insertLocalAssets(localPaths, docId) {
  if (!localPaths.length) return {};
  const data = await post("/api/asset/insertLocalAssets", {
    assetPaths: localPaths,
    id: docId,
    isUpload: true,
  });
  return data?.succMap || {};
}

async function listMeetingDocs(limit = 200) {
  const take = Math.max(1, Math.min(2000, Number(limit) || 200));
  // Join the attribute index instead of matching the whole IAL string; this
  // avoids false positives and, more importantly, avoids pulling the full
  // pre-meeting-notes attribute for every meeting in the list.
  const rows = await sql(
    `SELECT b.id, b.content, b.box, b.created, b.updated
      FROM blocks b
      JOIN attributes a ON a.block_id=b.id AND a.name='custom-meeting-id'
      LEFT JOIN attributes f ON f.block_id=b.id AND f.name='custom-meeting-first-recorded'
      WHERE b.type='d'
      GROUP BY b.id
      ORDER BY COALESCE(NULLIF(f.value,''), b.created) DESC
      LIMIT ${take}`,
  );
  if (!rows.length) return [];
  const names = [
    "custom-meeting-id",
    "custom-meeting-started",
    "custom-meeting-first-recorded",
    "custom-meeting-status",
    "custom-meeting-segments",
  ];
  const ids = rows.map((row) => sqlString(row.id)).join(",");
  const attrRows = await sql(
    `SELECT block_id, name, value FROM attributes
      WHERE block_id IN (${ids}) AND name IN (${names.map(sqlString).join(",")})`,
  );
  const attrsById = new Map();
  for (const attr of attrRows) {
    if (!attrsById.has(attr.block_id)) attrsById.set(attr.block_id, {});
    attrsById.get(attr.block_id)[attr.name] = attr.value;
  }
  return rows
    .map((row) => {
      const attrs = attrsById.get(row.id) || {};
      return {
        id: row.id,
        title: row.content,
        notebookId: row.box,
        meetingId: attrs["custom-meeting-id"] || "",
        startedAt: attrs["custom-meeting-started"] || "",
        firstRecordedAt: attrs["custom-meeting-first-recorded"] || "",
        status: attrs["custom-meeting-status"] || "",
        segments: Number(attrs["custom-meeting-segments"] || 0) || 0,
        updated: row.updated,
        created: row.created,
      };
    })
    .sort((a, b) =>
      String(b.firstRecordedAt || b.startedAt || b.updated || "").localeCompare(
        String(a.firstRecordedAt || a.startedAt || a.updated || ""),
      ),
    )
    .slice(0, take);
}

async function listChildDocs(parentID, kind = "") {
  const kindJoin = kind
    ? `JOIN attributes c ON c.block_id=b.id AND c.name='custom-meeting-child' AND c.value=${sqlString(kind)}`
    : "";
  const rows = await sql(
    `SELECT b.id, b.content, b.ial, b.created
      FROM blocks b
      JOIN attributes p ON p.block_id=b.id AND p.name='custom-meeting-parent' AND p.value=${sqlString(parentID)}
      ${kindJoin}
      WHERE b.type='d'
      GROUP BY b.id
      ORDER BY b.created ASC`,
  );
  return rows.map((row) => ({ id: row.id, title: row.content, attrs: parseIal(row.ial) }));
}

async function listBlocksWithAttr(parentID, attrName) {
  const rows = await sql(
    `SELECT b.id, b.type, b.content, b.ial, b.created
      FROM blocks b JOIN attributes a ON a.block_id=b.id AND a.name=${sqlString(attrName)}
      WHERE b.parent_id=${sqlString(parentID)}
      GROUP BY b.id
      ORDER BY b.created ASC`,
  );
  return rows.map((row) => ({ id: row.id, type: row.type, content: row.content, attrs: parseIal(row.ial) }));
}

async function getBlockInfo(id) {
  return post("/api/block/getBlockInfo", { id });
}

async function writeSecrets(entries) {
  const updates = entries
    .map((entry) => ({ name: entry.name, value: String(entry.value || "").trim() }))
    .filter((entry) => entry.name && entry.value);
  if (!updates.length) return;
  const names = new Set(updates.map((entry) => entry.name));
  const current = window.siyuan?.config?.secrets?.items || [];
  const next = current
    .filter((item) => item?.name && !names.has(item.name))
    .map((item) => ({
      name: item.name,
      value: item.value || "",
      ...(Array.isArray(item.allowedHosts) && item.allowedHosts.length
        ? { allowedHosts: item.allowedHosts }
        : {}),
    }));
  next.push(...updates);
  const data = await post("/api/setting/setSecrets", { items: next });
  window.siyuan.config.secrets = data || { items: next };
}

async function writeSecret(name, value) {
  return writeSecrets([{ name, value }]);
}

function openDoc(app, id) {
  return openTab({ app, doc: { id }, keepCursor: false });
}

module.exports = {
  post,
  sql,
  notebooks,
  currentNotebookId,
  getBlockAttrs,
  setBlockAttrs,
  createDoc,
  renameDoc,
  getHPath,
  getDocMeta,
  getBlockInfo,
  appendMarkdown,
  appendMarkdownRaw,
  prependMarkdownRaw,
  deleteBlocks,
  getDocMarkdown,
  resolveAssetPath,
  insertLocalAssets,
  listMeetingDocs,
  listChildDocs,
  listBlocksWithAttr,
  writeSecret,
  writeSecrets,
  openDoc,
};
