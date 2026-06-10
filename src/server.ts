/*
 * @Descripttion:
 * @version:
 * @Author: wangmin
 * @Date: 2025-03-20 17:49:38
 * @LastEditors: wangmin
 * @LastEditTime: 2026-06-10 00:00:00
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { IncomingMessage, ServerResponse } from "http";
import express from "express";
import { Response, Request } from "express-serve-static-core";
import { z } from "zod";

type OpenApiDocument = {
  openapi?: string;
  info?: {
    title?: string;
    [key: string]: unknown;
  };
  tags?: Array<{ name?: string; [key: string]: unknown }>;
  paths?: Record<string, unknown>;
  [key: string]: unknown;
};

type InterfaceSummary = {
  method: string;
  path: string;
  summary: string;
  operationId: string;
  tags: string[];
  apifoxFolders: string[];
  apifoxTags: string[];
};

type SearchMatch = {
  moduleName: string;
  score: number;
};

type InterfaceMatch = {
  method: string;
  path: string;
  summary: string;
  operationId: string;
  tags: string[];
  apifoxFolders: string[];
  apifoxTags: string[];
  score: number;
  matchedFields: string[];
};

const OPENAPI_METHODS = ["get", "post", "put", "delete", "patch"] as const;

export class ApiFoxServer {
  private readonly server: McpServer;
  private sseTransport: SSEServerTransport | null = null;
  private readonly apifoxApiKey: string;
  private readonly projectId: string;

  constructor(apifoxApiKey: string, projectId: string) {
    this.apifoxApiKey = apifoxApiKey;
    this.projectId = projectId;
    this.server = new McpServer({
      name: "ApiFox MCP Server",
      version: "1.0.0",
      capabilities: {
        notifications: true,
      },
    });

    this.registerTools();
  }

  private getAuthHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apifoxApiKey}`,
      "X-Apifox-Api-Version": "2024-03-28",
    };
  }

  private toTextContent(payload: unknown): {
    content: Array<{ type: "text"; text: string }>;
  } {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private summarizeText(text: string, limit = 1000): string {
    if (text.length <= limit) {
      return text;
    }

    return `${text.slice(0, limit)}...`;
  }

  private safeJsonParse(text: string): unknown | null {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private serializeQueryValue(value: unknown): string[] {
    if (value === null || value === undefined) {
      return [];
    }

    if (Array.isArray(value)) {
      return value.flatMap((item) => this.serializeQueryValue(item));
    }

    if (value instanceof Date) {
      return [value.toISOString()];
    }

    if (typeof value === "object") {
      return [JSON.stringify(value)];
    }

    return [String(value)];
  }

  private appendQueryParams(url: URL, query: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(query)) {
      for (const serialized of this.serializeQueryValue(value)) {
        url.searchParams.append(key, serialized);
      }
    }
  }

  private normalizeSearchText(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[\s_\-./\\,:;，。；、()（）[\]{}"'`~!@#$%^&*+=<>?|]+/g, "");
  }

  private dedupeStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const results: string[] = [];

    for (const value of values) {
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      results.push(normalized);
    }

    return results;
  }

  private collectStrings(
    value: unknown,
    output: string[],
    visited = new WeakSet<object>()
  ): void {
    if (typeof value === "string") {
      if (value.trim()) {
        output.push(value.trim());
      }
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    if (visited.has(value as object)) {
      return;
    }
    visited.add(value as object);

    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectStrings(item, output, visited);
      }
      return;
    }

    for (const nested of Object.values(value as Record<string, unknown>)) {
      this.collectStrings(nested, output, visited);
    }
  }

  private extractModuleCandidates(data: OpenApiDocument): string[] {
    const candidates: string[] = [];

    if (Array.isArray(data.tags)) {
      for (const tag of data.tags) {
        if (tag && typeof tag === "object") {
          const name = (tag as Record<string, unknown>).name;
          if (typeof name === "string" && name.trim()) {
            candidates.push(name.trim());
          }
        }
      }
    }

    const paths = data.paths && typeof data.paths === "object" ? data.paths : {};
    for (const pathItem of Object.values(paths)) {
      if (!pathItem || typeof pathItem !== "object") {
        continue;
      }

      const operations = pathItem as Record<string, unknown>;
      for (const method of OPENAPI_METHODS) {
        const operation = operations[method];
        if (!operation || typeof operation !== "object") {
          continue;
        }

        const operationRecord = operation as Record<string, unknown>;
        if (Array.isArray(operationRecord.tags)) {
          for (const tag of operationRecord.tags) {
            if (typeof tag === "string" && tag.trim()) {
              candidates.push(tag.trim());
            }
          }
        }

        this.collectStrings(operationRecord["x-apifox-folder"], candidates);
        this.collectStrings(operationRecord["x-apifox-tags"], candidates);
      }
    }

    return this.dedupeStrings(candidates);
  }

  private extractTextArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return this.dedupeStrings(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    );
  }

  private collectPathEvidence(value: unknown): string[] {
    const evidence: string[] = [];
    this.collectStrings(value, evidence);
    return this.dedupeStrings(evidence);
  }

  private scoreKeywordMatch(keyword: string, candidate: string): number {
    const normalizedKeyword = this.normalizeSearchText(keyword);
    const normalizedCandidate = this.normalizeSearchText(candidate);

    if (!normalizedKeyword || !normalizedCandidate) {
      return 0;
    }

    if (normalizedKeyword === normalizedCandidate) {
      return 100;
    }

    if (normalizedCandidate.includes(normalizedKeyword)) {
      return 95;
    }

    if (normalizedKeyword.includes(normalizedCandidate)) {
      return 90;
    }

    const keywordChars = new Set([...normalizedKeyword]);
    const candidateChars = new Set([...normalizedCandidate]);
    let commonChars = 0;
    for (const char of keywordChars) {
      if (candidateChars.has(char)) {
        commonChars += 1;
      }
    }

    const overlapBase = Math.max(Math.min(keywordChars.size, candidateChars.size), 1);
    return Math.round((commonChars / overlapBase) * 70);
  }

  private scoreCandidateWithEvidence(
    keyword: string,
    candidate: string,
    evidenceTexts: string[]
  ): number {
    const baseScore = this.scoreKeywordMatch(keyword, candidate);
    if (baseScore === 0) {
      return 0;
    }

    const normalizedKeyword = this.normalizeSearchText(keyword);
    const normalizedEvidence = evidenceTexts
      .map((value) => this.normalizeSearchText(value))
      .join("");

    let score = baseScore;
    if (normalizedEvidence.includes(normalizedKeyword)) {
      score += 10;
    } else {
      const keywordChars = new Set([...normalizedKeyword]);
      let matchedChars = 0;
      for (const char of keywordChars) {
        if (normalizedEvidence.includes(char)) {
          matchedChars += 1;
        }
      }
      score += Math.round((matchedChars / Math.max(keywordChars.size, 1)) * 10);
    }

    return Math.min(score, 100);
  }

  private scoreInterfaceMatch(keyword: string, item: InterfaceSummary): {
    score: number;
    matchedFields: string[];
  } {
    const matchedFields: string[] = [];
    let score = 0;

    const fields: Array<[string, string, number]> = [
      ["summary", item.summary, 100],
      ["path", item.path, 95],
      ["operationId", item.operationId, 85],
      ["tags", item.tags.join(" "), 80],
      ["apifoxFolders", item.apifoxFolders.join(" "), 90],
      ["apifoxTags", item.apifoxTags.join(" "), 88],
    ];

    for (const [fieldName, fieldValue, weight] of fields) {
      const fieldScore = this.scoreKeywordMatch(keyword, fieldValue);
      if (fieldScore > 0) {
        matchedFields.push(fieldName);
        score += Math.round((fieldScore * weight) / 100);
      }
    }

    const evidenceTexts = [
      item.summary,
      item.path,
      item.operationId,
      ...item.tags,
      ...item.apifoxFolders,
      ...item.apifoxTags,
    ];
    const normalizedKeyword = this.normalizeSearchText(keyword);
    const normalizedEvidence = this.normalizeSearchText(evidenceTexts.join(" "));
    if (normalizedKeyword && normalizedEvidence.includes(normalizedKeyword)) {
      score += 15;
    }

    if (matchedFields.length === 0) {
      return {
        score: 0,
        matchedFields: [],
      };
    }

    return {
      score: Math.min(score, 100),
      matchedFields: this.dedupeStrings(matchedFields),
    };
  }

  private async fetchOpenApiDocument(): Promise<OpenApiDocument | null> {
    const response = await fetch(
      `https://api.apifox.com/v1/projects/${this.projectId}/export-openapi`,
      {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          scope: {
            type: "ALL",
          },
          options: {
            includeApifoxExtensionProperties: true,
            addFoldersToTags: true,
          },
          oasVersion: "3.1",
          exportFormat: "JSON",
        }),
      }
    );

    const rawText = await response.text();
    const parsed = this.safeJsonParse(rawText);
    if (!response.ok || !parsed || typeof parsed !== "object") {
      console.error("[search-module] invalid response");
      return null;
    }

    return parsed as OpenApiDocument;
  }

  private async callErpApi(args: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    token: string;
  }): Promise<unknown> {
    const url = new URL(args.path, "https://erpapik.keychron.cn");

    if (args.query && Object.keys(args.query).length > 0) {
      this.appendQueryParams(url, args.query);
    }

    const init: RequestInit = {
      method: args.method,
      headers: {
        Authorization: `Bearer ${args.token}`,
        "Content-Type": "application/json",
      },
    };

    if (args.method === "POST" || args.method === "PUT") {
      init.body =
        args.body && Object.keys(args.body).length > 0
          ? JSON.stringify(args.body)
          : JSON.stringify({});
    }

    const response = await fetch(url, init);
    const rawText = await response.text();
    const parsed = this.safeJsonParse(rawText);

    if (parsed && typeof parsed === "object") {
      return parsed;
    }

    return {
      error: "无法解析 ERP 接口返回的 JSON",
      status: response.status,
      raw: this.summarizeText(rawText),
    };
  }

  private buildOpenApiInterfaceSummary(data: OpenApiDocument): {
    tags: string[];
    interfaces: InterfaceSummary[];
  } {
    const tags = this.extractModuleCandidates(data);
    const interfaces: InterfaceSummary[] = [];
    const paths = data.paths && typeof data.paths === "object" ? data.paths : {};

    for (const [path, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== "object") {
        continue;
      }

      const operations = pathItem as Record<string, unknown>;
      for (const method of OPENAPI_METHODS) {
        const operation = operations[method];
        if (!operation || typeof operation !== "object") {
          continue;
        }

        const operationRecord = operation as Record<string, unknown>;
        const summary =
          typeof operationRecord.summary === "string" ? operationRecord.summary : "";
        const operationId =
          typeof operationRecord.operationId === "string"
            ? operationRecord.operationId
            : "";
        const operationTags = this.extractTextArray(operationRecord.tags);
        const apifoxFolders = this.collectPathEvidence(operationRecord["x-apifox-folder"]);
        const apifoxTags = this.collectPathEvidence(operationRecord["x-apifox-tags"]);

        interfaces.push({
          method: method.toUpperCase(),
          path,
          summary,
          operationId,
          tags: operationTags,
          apifoxFolders,
          apifoxTags,
        });
      }
    }

    return {
      tags,
      interfaces,
    };
  }

  private findBestMatches(
    keyword: string,
    candidates: string[],
    evidenceResolver?: (candidate: string) => string[]
  ): SearchMatch[] {
    const matches: SearchMatch[] = [];

    for (const candidate of candidates) {
      const evidenceTexts = evidenceResolver ? evidenceResolver(candidate) : [];
      const score = evidenceResolver
        ? this.scoreCandidateWithEvidence(keyword, candidate, evidenceTexts)
        : this.scoreKeywordMatch(keyword, candidate);

      if (score > 0) {
        matches.push({
          moduleName: candidate,
          score,
        });
      }
    }

    matches.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.moduleName.localeCompare(right.moduleName, "zh-Hans-CN");
    });

    return matches.slice(0, 10);
  }

  private findBestTagForModule(
    moduleName: string,
    tags: string[],
    interfaces: InterfaceSummary[]
  ): { tag: string | null; score: number } {
    const scored = tags
      .map((tag) => {
        const evidenceTexts = interfaces
          .filter((item) => item.tags.includes(tag))
          .flatMap((item) => [item.summary, item.operationId, item.path, ...item.tags]);
        return {
          tag,
          score: this.scoreCandidateWithEvidence(moduleName, tag, evidenceTexts),
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.tag.localeCompare(right.tag, "zh-Hans-CN");
      });

    if (scored.length === 0) {
      return {
        tag: null,
        score: 0,
      };
    }

    return {
      tag: scored[0].tag,
      score: scored[0].score,
    };
  }

  private searchInterfaces(keyword: string, interfaces: InterfaceSummary[]): InterfaceMatch[] {
    const matches: InterfaceMatch[] = [];

    for (const item of interfaces) {
      const { score, matchedFields } = this.scoreInterfaceMatch(keyword, item);
      if (score <= 0) {
        continue;
      }

      matches.push({
        method: item.method,
        path: item.path,
        summary: item.summary,
        operationId: item.operationId,
        tags: item.tags,
        apifoxFolders: item.apifoxFolders,
        apifoxTags: item.apifoxTags,
        score,
        matchedFields,
      });
    }

    matches.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      const leftKey = `${left.method} ${left.path}`;
      const rightKey = `${right.method} ${right.path}`;
      return leftKey.localeCompare(rightKey, "zh-Hans-CN");
    });

    return matches.slice(0, 20);
  }

  private async handleSearchModule(
    keyword: string
  ): Promise<
    | {
        keyword: string;
        matched: SearchMatch[];
        candidateCount: number;
        error?: string;
      }
    | {
        error: string;
      }
  > {
    console.log("[search-module] keyword=", keyword);

    const openapi = await this.fetchOpenApiDocument();
    if (!openapi) {
      return {
        error: "无法解析 Apifox OpenAPI 数据",
      };
    }

    const { tags, interfaces } = this.buildOpenApiInterfaceSummary(openapi);
    console.log("[search-module] openapi tags count=", tags.length);

    const matched = this.findBestMatches(keyword, tags, (candidate) =>
      interfaces
        .filter((item) => item.tags.includes(candidate))
        .flatMap((item) => [item.summary, item.operationId, item.path, ...item.tags])
    );
    console.log("[search-module] matched count=", matched.length);

    return {
      keyword,
      matched,
      candidateCount: matched.length,
    };
  }

  private async handleSearchInterface(keyword: string): Promise<
    | {
        keyword: string;
        matched: InterfaceMatch[];
        candidateCount: number;
      }
    | {
        error: string;
      }
  > {
    console.log("[search-interface] keyword=", keyword);

    const openapi = await this.fetchOpenApiDocument();
    if (!openapi) {
      return {
        error: "无法解析 Apifox OpenAPI 数据",
      };
    }

    const { tags, interfaces } = this.buildOpenApiInterfaceSummary(openapi);
    console.log("[search-interface] openapi tags count=", tags.length);

    const matched = this.searchInterfaces(keyword, interfaces);
    console.log("[search-interface] matched count=", matched.length);

    return {
      keyword,
      matched,
      candidateCount: interfaces.length,
    };
  }

  private async handleGetInterface(keyword: string): Promise<unknown> {
    console.error("[get-interface] keyword=", keyword);

    if (!keyword || !keyword.trim()) {
      return {
        error: "keyword 不能为空",
      };
    }

    const openapi = await this.fetchOpenApiDocument();
    if (!openapi) {
      return {
        error: "无法解析 Apifox OpenAPI 数据",
      };
    }

    const { interfaces } = this.buildOpenApiInterfaceSummary(openapi);
    const matched = this.searchInterfaces(keyword, interfaces);

    if (matched.length === 0) {
      return {
        keyword,
        error: "未找到匹配的接口",
      };
    }

    const best = matched[0];
    return {
      keyword,
      matchedInterface: {
        method: best.method,
        path: best.path,
        summary: best.summary,
        operationId: best.operationId,
        tags: best.tags,
        apifoxFolders: best.apifoxFolders,
        apifoxTags: best.apifoxTags,
      },
      score: best.score,
      matchedFields: best.matchedFields,
      candidateCount: matched.length,
    };
  }

  private async handleCallErpApi(args: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    token: string;
  }): Promise<unknown> {
    console.error("[call-erp-api] method=", args.method, "path=", args.path);

    if (!args.path || !args.path.trim()) {
      return {
        error: "path 不能为空",
      };
    }

    if (!args.token || !args.token.trim()) {
      return {
        error: "token 不能为空",
      };
    }

    return this.callErpApi(args);
  }

  // 注册工具
  private registerTools(): void {
    this.server.tool(
      "search-module",
      "根据关键词搜索 Apifox 模块/文件夹",
      {
        keyword: z
          .string()
          .min(1)
          .describe("模块关键词，例如 采购、采购订单、库存、销售"),
      },
      async (args: { keyword: string }) => {
        const result = await this.handleSearchModule(args.keyword);
        return this.toTextContent(result);
      }
    );

    this.server.tool(
      "search-interface",
      "根据关键词搜索 Apifox 接口，返回最相关的接口候选",
      {
        keyword: z.string().min(1).describe("接口关键词，例如 采购订单列表、查询订单、更新SKU"),
      },
      async (args: { keyword: string }) => {
        const result = await this.handleSearchInterface(args.keyword);
        return this.toTextContent(result);
      }
    );

    this.server.tool(
      "get-interface",
      "根据关键词获取最匹配的 Apifox 接口",
      {
        keyword: z.string().min(1).describe("接口关键词，例如 采购订单列表、查询订单"),
      },
      async (args: { keyword: string }) => {
        const result = await this.handleGetInterface(args.keyword);
        return this.toTextContent(result);
      }
    );

    this.server.tool(
      "call-erp-api",
      "调用 ERP 实际接口并返回响应 JSON",
      {
        method: z.enum(["GET", "POST", "PUT", "DELETE"]),
        path: z.string().min(1).describe("接口路径，例如 /api/purchase-orders"),
        query: z
          .record(z.unknown())
          .optional()
          .describe("GET 查询参数对象，路径会自动拼接到 URL"),
        body: z
          .record(z.unknown())
          .optional()
          .describe("POST/PUT 请求体对象，将以 JSON 发送"),
        token: z.string().min(1).describe("ERP token"),
      },
      async (args: {
        method: "GET" | "POST" | "PUT" | "DELETE";
        path: string;
        query?: Record<string, unknown>;
        body?: Record<string, unknown>;
        token: string;
      }) => {
        const result = await this.handleCallErpApi(args);
        return this.toTextContent(result);
      }
    );
  }

  async connect(transport: Transport): Promise<void> {
    console.error("[ApiFox MCP] connect() invoked");
    await this.server.connect(transport);
    console.error("[ApiFox MCP] server connected and ready");
  }

  async startHttpServer(port: number): Promise<void> {
    const app = express();

    app.get("/sse", async (req: Request, res: Response) => {
      console.error("[ApiFox MCP] /sse connection established", {
        method: req.method,
        path: req.originalUrl,
        userAgent: req.headers["user-agent"],
      });
      this.sseTransport = new SSEServerTransport(
        "/messages",
        res as unknown as ServerResponse<IncomingMessage>
      );
      await this.connect(this.sseTransport);
    });

    app.post("/messages", async (req: Request, res: Response) => {
      console.error("[ApiFox MCP] /messages request received", {
        method: req.method,
        path: req.originalUrl,
        contentType: req.headers["content-type"],
        contentLength: req.headers["content-length"],
      });

      if (!this.sseTransport) {
        console.error("[ApiFox MCP] /messages received before SSE transport ready");
        res.status(400).send();
        return;
      }

      await this.sseTransport.handlePostMessage(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse<IncomingMessage>
      );
    });

    app.listen(port, () => {
      console.error("[ApiFox MCP] HTTP server listening on port", port);
      console.error(`[ApiFox MCP] SSE endpoint: http://localhost:${port}/sse`);
      console.error(`[ApiFox MCP] Messages endpoint: http://localhost:${port}/messages`);
    });
  }
}
