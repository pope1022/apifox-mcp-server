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

type ModuleMapItem = {
  moduleId: string;
  moduleName: string;
  aliases: string[];
  isPlaceholder?: boolean;
};

type InterfaceSummary = {
  method: string;
  path: string;
  summary: string;
  operationId: string;
  tags: string[];
};

const MODULE_MAP: ModuleMapItem[] = [
  {
    moduleId: "REPLACE_WITH_REAL_APIFOX_FOLDER_ID_PURCHASE",
    moduleName: "采购管理",
    aliases: ["采购", "采购订单", "PO单"],
    isPlaceholder: true,
  },
  {
    moduleId: "REPLACE_WITH_REAL_APIFOX_FOLDER_ID_INVENTORY",
    moduleName: "库存管理",
    aliases: ["库存", "SKU", "仓库"],
    isPlaceholder: true,
  },
  {
    moduleId: "REPLACE_WITH_REAL_APIFOX_FOLDER_ID_SALES",
    moduleName: "销售管理",
    aliases: ["销售", "销售订单"],
    isPlaceholder: true,
  },
];

const OPENAPI_METHODS = ["get", "post", "put", "delete", "patch"] as const;
const DEFAULT_FOLDER_LIST_ENDPOINTS = [
  "/v1/projects/{projectId}/folders",
  "/v1/projects/{projectId}/modules",
  "/v1/projects/{projectId}/project-folders",
  "/v1/projects/{projectId}/directories",
];

export class ApiFoxServer {
  private readonly server: McpServer;
  private sseTransport: SSEServerTransport | null = null;
  private readonly apifoxApiKey: string;
  private readonly projectId: string;
  private readonly folderListEndpoints: string[];

  constructor(apifoxApiKey: string, projectId: string) {
    this.apifoxApiKey = apifoxApiKey;
    this.projectId = projectId;
    this.folderListEndpoints = this.getFolderListEndpoints();
    this.server = new McpServer({
      name: "ApiFox MCP Server",
      version: "1.0.0",
      capabilities: {
        notifications: true,
      },
    });

    this.registerTools();
  }

  private getFolderListEndpoints(): string[] {
    const customEndpoints = process.env.APIFOX_FOLDER_LIST_ENDPOINTS?.split(",")
      .map((value: string) => value.trim())
      .filter(Boolean);

    return customEndpoints && customEndpoints.length > 0
      ? customEndpoints
      : DEFAULT_FOLDER_LIST_ENDPOINTS;
  }

  private getAuthHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apifoxApiKey}`,
      "X-Apifox-Api-Version": "2024-03-28",
    };
  }

  private toTextContent(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
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
    } catch (error) {
      console.error("[ApiFox MCP] JSON parse failed:", error);
      return null;
    }
  }

  private isNumericFolderId(moduleId: string): boolean {
    return /^-?\d+$/.test(moduleId.trim());
  }

  private toSelectedFolderId(moduleId: string): string | number {
    if (this.isNumericFolderId(moduleId)) {
      return Number(moduleId);
    }

    return moduleId;
  }

  private normalizeKeywords(keyword: string): string {
    return keyword.trim().toLowerCase();
  }

  private matchesKeyword(keyword: string, module: ModuleMapItem): boolean {
    const normalizedKeyword = this.normalizeKeywords(keyword);
    const candidates = [module.moduleName, ...module.aliases].map((value) =>
      this.normalizeKeywords(value)
    );

    return candidates.some((value) => value.includes(normalizedKeyword));
  }

  private dedupeModules(modules: ModuleMapItem[]): ModuleMapItem[] {
    const seen = new Set<string>();
    const results: ModuleMapItem[] = [];

    for (const module of modules) {
      const key = `${module.moduleId}:${module.moduleName}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(module);
    }

    return results;
  }

  private isUsableModule(module: ModuleMapItem): boolean {
    return !module.isPlaceholder && !module.moduleId.startsWith("REPLACE_WITH_REAL_");
  }

  private collectModuleCandidatesFromObject(
    value: unknown,
    output: ModuleMapItem[],
    visited = new WeakSet<object>()
  ): void {
    if (!value || typeof value !== "object") {
      return;
    }

    if (visited.has(value as object)) {
      return;
    }
    visited.add(value as object);

    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectModuleCandidatesFromObject(item, output, visited);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    const rawId =
      record.id ?? record.folderId ?? record.moduleId ?? record.value ?? record.key;
    const rawName =
      record.name ?? record.title ?? record.moduleName ?? record.label ?? record.text;
    const id =
      typeof rawId === "string" || typeof rawId === "number"
        ? String(rawId)
        : "";
    const name =
      typeof rawName === "string"
        ? rawName
        : typeof rawName === "number"
          ? String(rawName)
          : "";

    if (id && name) {
      const aliasesRaw =
        record.aliases ?? record.alias ?? record.keywords ?? record.tags ?? [];
      const aliases = Array.isArray(aliasesRaw)
        ? aliasesRaw
            .map((alias) => {
              if (typeof alias === "string") {
                return alias;
              }
              if (typeof alias === "number") {
                return String(alias);
              }
              return "";
            })
            .filter(Boolean)
        : [];

      output.push({
        moduleId: id,
        moduleName: name,
        aliases,
      });
    }

    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") {
        this.collectModuleCandidatesFromObject(nested, output, visited);
      }
    }
  }

  private async fetchModuleCandidatesFromApifoxApi(): Promise<ModuleMapItem[]> {
    const results: ModuleMapItem[] = [];

    for (const endpointTemplate of this.folderListEndpoints) {
      const endpoint = endpointTemplate.replace("{projectId}", this.projectId);
      console.error("[ApiFox MCP] search-module trying endpoint:", endpoint);

      try {
        const response = await fetch(`https://api.apifox.com${endpoint}`, {
          method: "GET",
          headers: this.getAuthHeaders(),
        });

        console.error(
          "[ApiFox MCP] search-module endpoint HTTP status:",
          response.status,
          endpoint
        );

        const rawText = await response.text();
        console.error(
          "[ApiFox MCP] search-module endpoint raw body preview:",
          this.summarizeText(rawText)
        );

        if (!response.ok) {
          continue;
        }

        const json = this.safeJsonParse(rawText);
        if (!json) {
          continue;
        }

        this.collectModuleCandidatesFromObject(json, results);
      } catch (error) {
        console.error(
          "[ApiFox MCP] search-module endpoint request failed:",
          endpoint,
          error
        );
      }
    }

    return this.dedupeModules(results);
  }

  private matchModules(keyword: string, modules: ModuleMapItem[]): ModuleMapItem[] {
    return modules.filter((module) => this.matchesKeyword(keyword, module));
  }

  private buildInterfaces(data: any): {
    interfaceCount: number;
    interfaces: InterfaceSummary[];
    truncated?: boolean;
  } {
    const interfaces: InterfaceSummary[] = [];
    const paths = data?.paths && typeof data.paths === "object" ? data.paths : {};

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
          typeof operationRecord.summary === "string"
            ? operationRecord.summary
            : "";
        const operationId =
          typeof operationRecord.operationId === "string"
            ? operationRecord.operationId
            : "";
        const tags = Array.isArray(operationRecord.tags)
          ? operationRecord.tags
              .map((tag) => {
                if (typeof tag === "string") {
                  return tag;
                }
                if (typeof tag === "number") {
                  return String(tag);
                }
                return "";
              })
              .filter(Boolean)
          : [];

        interfaces.push({
          method: method.toUpperCase(),
          path,
          summary,
          operationId,
          tags,
        });
      }
    }

    const interfaceCount = interfaces.length;
    if (interfaceCount <= 100) {
      return {
        interfaceCount,
        interfaces,
      };
    }

    return {
      interfaceCount,
      interfaces: interfaces.slice(0, 100),
      truncated: true,
    };
  }

  private async exportOpenApiByFolderId(
    moduleId: string
  ): Promise<globalThis.Response> {
    const selectedFolderId = this.toSelectedFolderId(moduleId);
    const payload = {
      scope: {
        type: "SELECTED_FOLDERS",
        selectedFolderIds: [selectedFolderId],
        excludedByTags: ["pet"],
      },
      options: {
        includeApifoxExtensionProperties: false,
        addFoldersToTags: true,
      },
      oasVersion: "3.1",
      exportFormat: "JSON",
    };

    const response = await fetch(
      `https://api.apifox.com/v1/projects/${this.projectId}/export-openapi`,
      {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: JSON.stringify(payload),
      }
    );

    console.error("[ApiFox MCP] get-interface HTTP status:", response.status);
    return response;
  }

  private async handleSearchModule(keyword: string): Promise<{
    keyword: string;
    matched: ModuleMapItem[];
    message?: string;
  }> {
    console.error("[ApiFox MCP] search-module called with keyword:", keyword);

    const apiCandidates = await this.fetchModuleCandidatesFromApifoxApi();
    const sourceCandidates = this.dedupeModules([
      ...apiCandidates,
      ...MODULE_MAP.filter((module) => this.isUsableModule(module)),
    ]);

    const matched = this.matchModules(keyword, sourceCandidates);

    if (matched.length > 0) {
      return {
        keyword,
        matched,
      };
    }

    return {
      keyword,
      matched: [],
      message:
        "未找到匹配模块。请检查项目下的真实 Apifox folder 列表，或通过 APIFOX_FOLDER_LIST_ENDPOINTS 配置正确的目录查询接口。",
    };
  }

  private async handleGetInterface(moduleId: string): Promise<unknown> {
    console.error("[ApiFox MCP] get-interface called with moduleId:", moduleId);

    if (!moduleId || !moduleId.trim()) {
      return {
        moduleId,
        error: "moduleId 不能为空",
      };
    }

    if (moduleId.startsWith("REPLACE_WITH_REAL_")) {
      return {
        moduleId,
        error:
          "moduleId 仍是占位值，请先通过 search-module 获取真实 Apifox folderId，或在 MODULE_MAP 中配置真实 folderId。",
      };
    }

    try {
      const response = await this.exportOpenApiByFolderId(moduleId.trim());
      const rawText = await response.text();

      console.error(
        "[ApiFox MCP] get-interface raw response preview:",
        this.summarizeText(rawText)
      );

      if (!response.ok) {
        return {
          moduleId,
          status: response.status,
          error: "Apifox export-openapi 请求失败",
          bodySummary: this.summarizeText(rawText),
        };
      }

      const data = this.safeJsonParse(rawText);
      if (!data || typeof data !== "object") {
        return {
          moduleId,
          status: response.status,
          error: "Apifox export-openapi 返回不是有效 JSON",
          bodySummary: this.summarizeText(rawText),
        };
      }

      const openapiData = data as any;
      const pathCount =
        openapiData?.paths && typeof openapiData.paths === "object"
          ? Object.keys(openapiData.paths).length
          : 0;

      console.error("[ApiFox MCP] OpenAPI paths count:", pathCount);

      const summary = this.buildInterfaces(openapiData);
      if (summary.interfaceCount === 0) {
        return {
          moduleId,
          interfaceCount: 0,
          error:
            "该 moduleId 导出的 OpenAPI paths 为空。可能原因：moduleId 不是 Apifox folderId，或该文件夹下没有接口。",
          suggestion:
            "请先调用 search-module，并确认 MODULE_MAP 中配置的是真实 Apifox folderId。",
        };
      }

      return {
        moduleId,
        openapi: openapiData.openapi,
        title: openapiData.info?.title,
        interfaceCount: summary.interfaceCount,
        interfaces: summary.interfaces,
        ...(summary.truncated ? { truncated: true } : {}),
      };
    } catch (error) {
      console.error("[ApiFox MCP] get-interface failed:", error);
      return {
        moduleId,
        error: `获取接口信息失败: ${error}`,
      };
    }
  }

  // 注册工具
  private registerTools(): void {
    this.server.tool(
      "search-module",
      "根据关键词搜索 Apifox 模块/文件夹，返回可用于 get-interface 的 moduleId",
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
      "get-interface",
      "获取 Apifox 文件夹导出的 OpenAPI 接口摘要",
      {
        moduleId: z
          .string()
          .min(1)
          .describe("Apifox 文件夹 ID，必须来自 search-module 返回结果"),
      },
      async (args: { moduleId: string }) => {
        const result = await this.handleGetInterface(args.moduleId);
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
