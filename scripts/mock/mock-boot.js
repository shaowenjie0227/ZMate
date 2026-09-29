/*
 * ZMate 浏览器端 Tauri IPC mock(仅用于 GUI 功能测试,不进入生产构建)。
 * 在真实 Tauri 运行时中不做任何事;在浏览器中伪装 __TAURI_INTERNALS__,
 * 以内存态 fixture 响应全部核心命令,并支持通过 __ZMATE_MOCK__ 触发事件/错误。
 */
(function () {
  if (window.__TAURI_INTERNALS__) return; // 真实 Tauri 环境,不干预

  var callbacks = new Map();
  var nextCbId = 1;
  var eventBindings = []; // { event, cbId }
  var nextEventId = 1;
  var failOnce = {}; // cmd -> true,下一次调用该命令时抛错(测试错误态)

  // ------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------
  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }
  function nowMs() {
    return Date.now();
  }
  function ok(data) {
    return { schemaVersion: 1, success: true, code: "ok", message: "", warnings: [], data: data };
  }
  function dateStr(offsetDays) {
    var d = new Date(Date.now() - offsetDays * 86400000);
    return d.toISOString().slice(0, 10);
  }
  // 确定性伪随机(0-1)
  function lcg(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  // ------------------------------------------------------------------
  // 内存态数据
  // ------------------------------------------------------------------
  var state = {
    site: {
      connected: true,
      baseUrl: "https://mock.newapi.example.com",
      accessToken: "sk-mock-access-token",
      userId: 7,
      authMethod: "token",
    },
    settings: { checkZcodeRunning: true },
    proxy: { enabled: false, port: null },
    quota: 5000000,
    usedQuota: 1234567,
  };

  var providers = [
    {
      providerId: "zai-official",
      providerName: "ZAI Official",
      apiType: "anthropic-messages",
      baseUrl: "https://api.z.ai/api/anthropic",
      modelCount: 3,
      enabled: true,
      apiKeySet: true,
      models: [
        {
          modelId: "glm-4.7",
          enabled: true,
          contextWindow: 200000,
          supportsImage: true,
          maxOutputTokens: 16384,
          supportsVideo: false,
          supportsPdf: true,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: true,
          supportsMidConversationSystem: true,
          reasoning: { values: ["off", "low", "medium", "high"], map: "thinking.type" },
        },
        {
          modelId: "glm-4.7-air",
          enabled: true,
          contextWindow: 128000,
          supportsImage: true,
          maxOutputTokens: 8192,
          supportsVideo: false,
          supportsPdf: false,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: true,
          reasoning: null,
        },
        {
          modelId: "glm-4.6",
          enabled: false,
          contextWindow: 200000,
          supportsImage: false,
          maxOutputTokens: 8192,
          supportsVideo: false,
          supportsPdf: false,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: true,
          reasoning: { values: ["off", "high"], map: "thinking.type" },
        },
      ],
    },
    {
      providerId: "openrouter",
      providerName: "OpenRouter",
      apiType: "openai-chat-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      modelCount: 2,
      enabled: false,
      apiKeySet: true,
      models: [
        {
          modelId: "deepseek/deepseek-chat-v3",
          enabled: true,
          contextWindow: 64000,
          supportsImage: false,
          maxOutputTokens: 8192,
          supportsVideo: false,
          supportsPdf: false,
          supportsJsonSchemaOutput: true,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: true,
          reasoning: null,
        },
        {
          modelId: "qwen/qwen3-max",
          enabled: true,
          contextWindow: 131072,
          supportsImage: false,
          maxOutputTokens: 16384,
          supportsVideo: false,
          supportsPdf: false,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: true,
          supportsMidConversationSystem: false,
          reasoning: null,
        },
      ],
    },
  ];
  var providerOrder = ["zai-official", "openrouter"];

  var tokens = [
    {
      id: 11,
      name: "zmate-main",
      status: 1,
      key: "mock1111",
      remainQuota: 2000000,
      usedQuota: 800000,
      unlimitedQuota: false,
      expiredTime: -1,
      createdTime: nowSec() - 86400 * 40,
      accessedTime: nowSec() - 3600,
      group: "default",
    },
    {
      id: 12,
      name: "ci-pipeline",
      status: 2,
      key: "mock2222",
      remainQuota: 0,
      usedQuota: 250000,
      unlimitedQuota: false,
      expiredTime: nowSec() + 86400 * 30,
      createdTime: nowSec() - 86400 * 10,
      accessedTime: nowSec() - 7200,
      group: "vip",
    },
    {
      id: 13,
      name: "scratch-key",
      status: 1,
      key: "mock3333",
      remainQuota: 0,
      usedQuota: 1000,
      unlimitedQuota: true,
      expiredTime: -1,
      createdTime: nowSec() - 86400 * 2,
      accessedTime: nowSec() - 600,
      group: "default",
    },
  ];
  var nextTokenId = 20;

  var mcpServers = [
    {
      name: "context7",
      transport: "http",
      enabled: true,
      sourcePath: "C:\\Users\\shaowenjie\\.zcode\\cli-config.json",
      command: null,
      args: [],
      url: "https://mcp.context7.com/mcp",
      headers: { "CONTEXT7_API_KEY": "mock-key" },
      environment: {},
    },
    {
      name: "zcode-browser",
      transport: "stdio",
      enabled: true,
      sourcePath: "C:\\Users\\shaowenjie\\.zcode\\cli-config.json",
      command: "npx",
      args: ["-y", "zcode-browser-mcp@latest"],
      url: null,
      headers: {},
      environment: { NODE_ENV: "production" },
    },
    {
      name: "filesystem",
      transport: "stdio",
      enabled: false,
      sourcePath: "C:\\Users\\shaowenjie\\.zcode\\cli-config.json",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\shaowenjie\\Desktop"],
      url: null,
      headers: {},
      environment: {},
    },
  ];

  var skills = [
    ["browser-use", "Browser Use", "浏览器自动化测试"],
    ["web-gui-tester", "Web GUI Tester", "Web 前端黑盒 GUI 测试"],
    ["dynamic-workflows", "Dynamic Workflows", "多子代理编排工作流"],
    ["docx", "DOCX Toolkit", "Word 文档创建与转换"],
    ["pdf", "PDF Toolkit", "PDF 报告与文档处理"],
    ["skill-creator", "Skill Creator", "创建与维护 Skills"],
  ].map(function (row, i) {
    return {
      id: row[0],
      name: row[0],
      title: row[1],
      summary: row[2],
      relativePath: "skills/" + row[0],
      directoryPath: "C:\\Users\\shaowenjie\\.zcode\\skills\\" + row[0],
      skillFilePath: "C:\\Users\\shaowenjie\\.zcode\\skills\\" + row[0] + "\\SKILL.md",
      updatedAt: nowSec() - 86400 * (i + 1),
    };
  });

  var skillBackups = [
    {
      id: "backup-old-web-gui-tester",
      skillID: "web-gui-tester",
      name: "web-gui-tester",
      title: "Web GUI Tester(旧版)",
      relativePath: "backups/skills/web-gui-tester-001",
      backupPath: "C:\\Users\\shaowenjie\\.zcode\\zmate\\backups\\skills\\web-gui-tester-001",
      createdAt: nowSec() - 86400 * 3,
    },
    {
      id: "backup-docx",
      skillID: "docx",
      name: "docx",
      title: "DOCX Toolkit(旧版)",
      relativePath: "backups/skills/docx-001",
      backupPath: "C:\\Users\\shaowenjie\\.zcode\\zmate\\backups\\skills\\docx-001",
      createdAt: nowSec() - 86400 * 9,
    },
  ];
  var nextBackupId = 3;

  var instructionState = {
    current: {
      globalPath: "C:\\Users\\shaowenjie\\.zcode\\AGENTS.md",
      fileExists: true,
      managedBlockPresent: true,
      protectionState: "ready",
      issueMessage: null,
      managedContent:
        "<!-- ZMATE_GLOBAL_BEGIN -->\n- 始终使用简体中文回复\n- 修改代码前先阅读相邻实现\n<!-- ZMATE_GLOBAL_END -->",
      lastAppliedAt: nowSec() - 86400,
      lastTemplateCode: "zh-reply",
      lastTemplateTitle: "中文回复",
    },
    history: [
      {
        id: "hist-2",
        createdAt: nowSec() - 86400,
        action: "apply",
        source: "manual",
        templateCode: "zh-reply",
        templateTitle: "中文回复",
      },
      {
        id: "hist-1",
        createdAt: nowSec() - 86400 * 5,
        action: "apply",
        source: "manual",
        templateCode: null,
        templateTitle: null,
      },
    ],
  };

  var sessions = [
    ["task-001", "C:\\proj\\ZMate", "重构仪表盘趋势图组件", "completed", "zai-official", "glm-4.7", "build"],
    ["task-002", "C:\\proj\\ZMate", "修复会话导入目标目录问题", "completed", "zai-official", "glm-4.7", "build"],
    ["task-003", "C:\\proj\\website", "首页性能优化调研", "running", "openrouter", "deepseek/deepseek-chat-v3", "plan"],
    ["task-004", "C:\\proj\\ZMate", "站点接入向导 UX 打磨", "completed", "zai-official", "glm-4.7-air", "build"],
    ["task-005", "C:\\proj\\docs", "README 中英文同步", "completed", null, null, "build"],
    ["task-006", "C:\\proj\\ZMate", "Tauri 更新器集成测试", "error", "zai-official", "glm-4.7", "build"],
    ["task-007", "C:\\proj\\lab", "Rust zip 导出实验", "completed", "openrouter", "qwen/qwen3-max", "build"],
    ["task-008", "C:\\proj\\ZMate", "MCP 配置备份机制", "archived", "zai-official", "glm-4.7", "build"],
  ].map(function (row, i) {
    return {
      taskId: row[0],
      workspacePath: row[1],
      title: row[2],
      status: row[3],
      provider: row[4],
      model: row[5],
      mode: row[6],
      pinned: i === 0,
      archived: row[3] === "archived",
      createdAt: nowMs() - (i + 1) * 86400000 * 2,
      updatedAt: nowMs() - (i + 1) * 3600000 * 5,
    };
  });

  function sessionMessages(taskId) {
    var base = nowMs() - 3600000;
    return [
      {
        id: taskId + "-m1",
        role: "user",
        timeCreated: base - 300000,
        parts: [{ kind: "text", text: "帮我看看这个组件为什么渲染两次?" }],
      },
      {
        id: taskId + "-m2",
        role: "assistant",
        timeCreated: base - 240000,
        parts: [
          {
            kind: "text",
            text: "React StrictMode 在开发模式下会双重渲染组件,这是预期行为。生产构建只会渲染一次。",
          },
        ],
      },
      {
        id: taskId + "-m3",
        role: "user",
        timeCreated: base - 180000,
        parts: [{ kind: "text", text: "那热更新后的重复请求呢?" }],
      },
      {
        id: taskId + "-m4",
        role: "assistant",
        timeCreated: base - 120000,
        parts: [
          { kind: "text", text: "检查 useEffect 依赖数组,频繁重建对象引用会触发重新请求。" },
          { kind: "reasoning", text: "需要确认 query key 的稳定性" },
        ],
      },
      {
        id: taskId + "-m5",
        role: "user",
        timeCreated: base - 60000,
        parts: [{ kind: "text", text: "明白了,感谢!" }],
      },
    ];
  }

  // ------------------------------------------------------------------
  // 仪表盘序列(确定性生成)
  // ------------------------------------------------------------------
  function buildDashboard() {
    var rand = lcg(20260929);
    var activity = [];
    for (var d = 119; d >= 0; d--) {
      var dow = new Date(Date.now() - d * 86400000).getDay();
      var weekend = dow === 0 || dow === 6 ? 0.35 : 1;
      activity.push({
        date: dateStr(d),
        count: Math.max(0, Math.round((8 + rand() * 26) * weekend)),
      });
    }
    function hourlySeries(seed, scale) {
      var rand2 = lcg(seed);
      var days = [];
      for (var i = 29; i >= 0; i--) {
        var counts = [];
        for (var h = 0; h < 24; h++) {
          var workHours = h >= 9 && h <= 22 ? 1 : 0.15;
          counts.push(Math.round(rand2() * 14 * workHours * scale));
        }
        days.push({ date: dateStr(i), counts: counts });
      }
      return days;
    }
    var tokenDays = [];
    var rand3 = lcg(777);
    for (var t = 89; t >= 0; t--) {
      var input = Math.round(40000 + rand3() * 160000);
      var output = Math.round(input * (0.2 + rand3() * 0.35));
      var reasoning = Math.round(output * rand3() * 0.5);
      tokenDays.push({
        date: dateStr(t),
        inputTokens: input,
        outputTokens: output,
        reasoningTokens: reasoning,
        totalTokens: input + output + reasoning,
      });
    }
    var modelTokenDays = [];
    var models = [
      ["glm-4.7", 0.62],
      ["glm-4.7-air", 0.25],
      ["deepseek/deepseek-chat-v3", 0.13],
    ];
    var rand4 = lcg(31415);
    for (var m = 0; m < models.length; m++) {
      for (var k = 89; k >= 0; k--) {
        var input2 = Math.round((20000 + rand4() * 90000) * models[m][1]);
        var output2 = Math.round(input2 * (0.15 + rand4() * 0.3));
        var reasoning2 = Math.round(output2 * rand4() * 0.4);
        modelTokenDays.push({
          date: dateStr(k),
          modelId: models[m][0],
          inputTokens: input2,
          outputTokens: output2,
          reasoningTokens: reasoning2,
          totalTokens: input2 + output2 + reasoning2,
        });
      }
    }
    return {
      providerCount: providers.length,
      modelCount: providers.reduce(function (n, p) {
        return n + p.models.length;
      }, 0),
      sessionCount: 87,
      sessionStorageBytes: 50663424,
      mcpTotal: mcpServers.length,
      mcpEnabled: mcpServers.filter(function (s) {
        return s.enabled;
      }).length,
      skillCount: skills.length,
      skillBackupCount: skillBackups.length,
      zcodeRunning: true,
      zcodeHome: "C:\\Users\\shaowenjie\\.zcode",
      coreVersion: "2.6.3",
      pathChecks: [
        { key: "zcodeHome", path: "C:\\Users\\shaowenjie\\.zcode", exists: true },
        { key: "providerConfig", path: "C:\\Users\\shaowenjie\\.zcode\\provider_config.json", exists: true },
        { key: "cliConfig", path: "C:\\Users\\shaowenjie\\.zcode\\cli-config.json", exists: true },
        { key: "skillsDir", path: "C:\\Users\\shaowenjie\\.zcode\\skills", exists: true },
        { key: "agentsMd", path: "C:\\Users\\shaowenjie\\.zcode\\AGENTS.md", exists: true },
        { key: "tasksDb", path: "C:\\Users\\shaowenjie\\.zcode\\tasks.db", exists: true },
      ],
      providerConfigValid: true,
      providerConfigError: null,
      cliConfigValid: true,
      cliConfigError: null,
      activity: activity,
      hourlyActivity: hourlySeries(1001, 1),
      hourlyTokens: hourlySeries(2002, 0.7),
      tokenDays: tokenDays,
      modelTokenDays: modelTokenDays,
      generatedAt: nowSec(),
    };
  }

  var dashboardCache = null;

  // ------------------------------------------------------------------
  // 站点日志(确定性生成,42 条,近 30 天)
  // ------------------------------------------------------------------
  function buildLogs() {
    var rand = lcg(424242);
    var items = [];
    var models = ["glm-4.7", "glm-4.7-air", "deepseek/deepseek-chat-v3"];
    for (var i = 0; i < 42; i++) {
      var type = i % 11 === 0 ? 1 : i % 17 === 0 ? 5 : 2;
      var created = nowSec() - Math.floor(rand() * 86400 * 30);
      var prompt = Math.round(500 + rand() * 24000);
      var completion = Math.round(100 + rand() * 4000);
      var cache = Math.round(prompt * rand() * 0.7);
      items.push({
        id: 9000 + i,
        createdAt: created,
        logType: type,
        content:
          type === 1
            ? "在线充值 +$20.00"
            : type === 5
              ? "模型返回 429 Too Many Requests"
              : "对话补全请求",
        modelName: type === 2 ? models[i % 3] : "",
        tokenName: i % 3 === 0 ? "zmate-main" : i % 3 === 1 ? "scratch-key" : "ci-pipeline",
        quota: type === 2 ? Math.round(rand() * 8000) : 0,
        promptTokens: type === 2 ? prompt : 0,
        completionTokens: type === 2 ? completion : 0,
        useTime: type === 2 ? Math.round(1 + rand() * 40) : 0,
        frtMs: type === 2 ? (i % 9 === 0 ? -1 : Math.round(200 + rand() * 2500)) : -1,
        cacheTokens: type === 2 ? cache : 0,
        isStream: type === 2 && i % 4 !== 0,
        group: i % 3 === 0 ? "default" : "vip",
      });
    }
    items.sort(function (a, b) {
      return b.createdAt - a.createdAt;
    });
    return items;
  }
  var logItems = buildLogs();

  // ------------------------------------------------------------------
  // 事件派发
  // ------------------------------------------------------------------
  function emitEvent(event, payload) {
    var delivery = { event: event, id: nextEventId++, payload: payload };
    eventBindings.forEach(function (b) {
      if (b.event !== event) return;
      var cb = callbacks.get(b.cbId);
      if (cb) {
        try {
          cb.fn(delivery);
        } catch (e) {
          /* 忽略监听器异常 */
        }
      }
    });
  }

  // ------------------------------------------------------------------
  // 命令处理表
  // ------------------------------------------------------------------
  var handlers = {
    // ---------- Providers ----------
    load_providers: function () {
      return ok({
        items: providers,
        providerOrder: providerOrder,
        sourcePath: "C:\\Users\\shaowenjie\\.zcode\\provider_config.json",
        configExists: true,
        lastScanAt: nowSec(),
      });
    },
    fetch_provider_models: function () {
      return ok({ items: ["glm-4.7", "glm-4.7-air", "glm-4.6", "glm-4.5-air"] });
    },
    test_provider_connectivity: function () {
      return ok({ reachable: true, statusCode: 200, message: "连接正常", latencyMs: 233 });
    },
    test_provider: function () {
      return ok({ reachable: true, statusCode: 200, message: "连接正常", latencyMs: 189 });
    },
    test_provider_model: function (args) {
      return ok({
        success: true,
        statusCode: 200,
        latencyMs: 812,
        message: "模型响应正常",
        replyPreview: "你好!这是来自 " + args.modelId + " 的测试回复。",
      });
    },
    stream_test_provider_model: function (args) {
      var stages = ["sent", "headers", "first-packet", "done"];
      stages.forEach(function (stage, i) {
        setTimeout(function () {
          emitEvent("provider-stream-test-progress", {
            providerId: args.providerId,
            modelId: args.modelId,
            stage: stage,
            statusCode: 200,
            elapsedMs: 120 * (i + 1) + 60,
          });
        }, 250 * (i + 1));
      });
      return ok({
        success: true,
        providerId: args.providerId,
        modelId: args.modelId,
        statusCode: 200,
        host: "api.z.ai",
        path: "/api/anthropic/v1/messages",
        headerMs: 245,
        firstPacketMs: 623,
        totalMs: 1821,
        reply: "这是一段流式返回的测试回复内容,用于验证 SSE 分阶段计时展示。",
        message: "流式测试完成",
      });
    },
    upsert_provider: function (args) {
      var input = args.input;
      var id = input.providerId || input.providerName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      var summary = {
        providerId: id,
        providerName: input.providerName,
        apiType: input.apiType,
        baseUrl: input.baseUrl,
        modelCount: input.models.length,
        enabled: true,
        apiKeySet: !!input.apiKey,
        models: input.models.map(function (m) {
          return {
            modelId: m.modelId,
            enabled: true,
            contextWindow: m.contextWindow ?? null,
            supportsImage: m.supportsImage ?? null,
            maxOutputTokens: m.maxOutputTokens ?? null,
            supportsVideo: m.supportsVideo ?? null,
            supportsPdf: m.supportsPdf ?? null,
            supportsJsonSchemaOutput: m.supportsJsonSchemaOutput ?? null,
            supportsNativeWebSearch: m.supportsNativeWebSearch ?? null,
            supportsMidConversationSystem: m.supportsMidConversationSystem ?? null,
            reasoning: m.reasoningLevels ? { values: m.reasoningLevels, map: m.reasoningMap || "default" } : null,
          };
        }),
      };
      var idx = providers.findIndex(function (p) {
        return p.providerId === id;
      });
      if (idx >= 0) providers[idx] = summary;
      else providers.push(summary);
      if (providerOrder.indexOf(id) < 0) providerOrder.push(id);
      return ok({
        provider: summary,
        backupPath: "C:\\Users\\shaowenjie\\.zcode\\zmate\\backups\\provider_config." + nowSec() + ".bak",
      });
    },
    remove_provider: function (args) {
      providers = providers.filter(function (p) {
        return p.providerId !== args.providerId;
      });
      providerOrder = providerOrder.filter(function (id) {
        return id !== args.providerId;
      });
      return ok({
        removedProviderId: args.providerId,
        backupPath: "C:\\Users\\shaowenjie\\.zcode\\zmate\\backups\\provider_config." + nowSec() + ".bak",
      });
    },
    set_provider_enabled: function (args) {
      var p = providers.find(function (x) {
        return x.providerId === args.providerId;
      });
      if (p) {
        p.enabled = args.enabled;
        p.models.forEach(function (m) {
          m.enabled = args.enabled;
        });
      }
      return ok({
        provider: p,
        backupPath: "C:\\Users\\shaowenjie\\.zcode\\zmate\\backups\\provider_config." + nowSec() + ".bak",
      });
    },

    // ---------- NewAPI 站点 ----------
    newapi_probe_site: function () {
      return ok({
        systemName: "Mock New API",
        version: "v1.2.3",
        userId: 7,
        username: "tester",
        displayName: "Tester",
        group: "default",
        quota: state.quota,
        usedQuota: state.usedQuota,
        quotaPerUnit: 500000,
      });
    },
    newapi_list_tokens: function () {
      return ok(tokens);
    },
    newapi_reveal_token_key: function (args) {
      var t = tokens.find(function (x) {
        return x.id === args.tokenId;
      });
      return ok(t ? "sk-mock-" + t.key : "sk-mock-unknown");
    },
    newapi_affiliate_info: function () {
      return ok({
        affCode: "ZMATE42",
        referralUrl: "https://mock.newapi.example.com/register?aff=ZMATE42",
        pendingQuota: 125000,
        historyQuota: 500000,
        inviteCount: 3,
      });
    },
    newapi_invited_users: function (args) {
      var total = 5;
      var items = [];
      for (var i = (args.page - 1) * args.pageSize; i < Math.min(args.page * args.pageSize, total); i++) {
        items.push({ id: i + 1, username: "invited_user_" + (i + 1), quota: 50000 });
      }
      return ok({ page: args.page, pageSize: args.pageSize, total: total, items: items });
    },
    newapi_transfer_aff_quota: function () {
      return ok(true);
    },
    newapi_list_groups: function () {
      return ok([
        { name: "default", ratio: 1.0 },
        { name: "vip", ratio: 0.8 },
      ]);
    },
    newapi_list_models: function () {
      return ok(["glm-4.7", "glm-4.7-air", "glm-4.6", "deepseek/deepseek-chat-v3", "qwen/qwen3-max"]);
    },
    newapi_create_token: function (args) {
      var t = {
        id: nextTokenId++,
        name: args.input.name,
        key: "mocknew" + nextTokenId,
      };
      tokens.push({
        id: t.id,
        name: t.name,
        status: 1,
        key: t.key,
        remainQuota: args.input.remainQuota ?? 0,
        usedQuota: 0,
        unlimitedQuota: args.input.unlimitedQuota,
        expiredTime: args.input.expiredTime ?? -1,
        createdTime: nowSec(),
        accessedTime: nowSec(),
        group: args.input.group || "default",
      });
      return ok(t);
    },
    newapi_user_profile: function () {
      return ok({
        systemName: "Mock New API",
        username: "tester",
        displayName: "Tester",
        email: "tester@example.com",
        group: "default",
        role: 1,
        quota: state.quota,
        usedQuota: state.usedQuota,
        requestCount: 1287,
        quotaPerUnit: 500000,
      });
    },
    newapi_login_with_password: function (args) {
      state.site.connected = true;
      state.site.baseUrl = args.baseUrl;
      state.site.authMethod = "password";
      return ok({
        systemName: "Mock New API",
        version: "v1.2.3",
        userId: 7,
        username: args.username,
        displayName: args.username,
        group: "default",
        quota: state.quota,
        usedQuota: state.usedQuota,
        quotaPerUnit: 500000,
      });
    },
    newapi_site_connection_status: function () {
      return ok({
        connected: state.site.connected,
        baseUrl: state.site.baseUrl,
        authMethod: state.site.authMethod,
      });
    },
    newapi_verify_site_connection: function () {
      return state.site.connected
        ? ok({ ok: true, systemName: "Mock New API", username: "tester", message: "连接正常" })
        : ok({ ok: false, systemName: "", username: "", message: "未连接站点" });
    },
    newapi_save_site_connection: function (args) {
      state.site.connected = true;
      state.site.baseUrl = args.baseUrl;
      state.site.accessToken = args.accessToken;
      state.site.userId = args.userId || 0;
      state.site.authMethod = "token";
      return ok(true);
    },
    newapi_clear_site_connection: function () {
      state.site.connected = false;
      return ok(true);
    },
    newapi_site_usage: function () {
      if (!state.site.connected) return ok({ connected: false, baseUrl: "", summary: null });
      return ok({
        connected: true,
        baseUrl: state.site.baseUrl,
        summary: {
          systemName: "Mock New API",
          balanceQuota: state.quota,
          usedQuota: state.usedQuota,
          quotaPerUnit: 500000,
          today: { quota: 42500, tokens: 38200 },
          week: { quota: 236800, tokens: 241500 },
          month: { quota: 934500, tokens: 986300 },
        },
      });
    },
    newapi_wallet: function () {
      if (!state.site.connected) return ok({ connected: false, stats: null });
      return ok({
        connected: true,
        stats: {
          systemName: "Mock New API",
          username: "tester",
          balanceQuota: state.quota,
          usedQuota: state.usedQuota,
          quotaPerUnit: 500000,
          requestCount: 1287,
        },
      });
    },
    newapi_redeem: function (args) {
      var granted = 500000;
      state.quota += granted;
      return ok({
        grantedQuota: granted,
        balanceQuota: state.quota,
        usedQuota: state.usedQuota,
        quotaPerUnit: 500000,
      });
    },
    newapi_keys: function () {
      return ok({ connected: state.site.connected, items: tokens });
    },
    newapi_delete_token: function (args) {
      tokens = tokens.filter(function (t) {
        return t.id !== args.id;
      });
      return ok(true);
    },
    newapi_set_token_status: function (args) {
      var t = tokens.find(function (x) {
        return x.id === args.id;
      });
      if (t) t.status = args.status;
      return ok(true);
    },
    newapi_logs: function (args) {
      var filtered = logItems.filter(function (l) {
        if (args.logType > 0 && l.logType !== args.logType) return false;
        if (args.start > 0 && l.createdAt < args.start) return false;
        if (args.end > 0 && l.createdAt > args.end) return false;
        return true;
      });
      var startIdx = (args.page - 1) * args.pageSize;
      return ok({
        items: filtered.slice(startIdx, startIdx + args.pageSize),
        total: filtered.length,
      });
    },

    // ---------- MCP ----------
    load_mcp_servers: function () {
      return ok({
        items: mcpServers,
        total: mcpServers.length,
        sourcePath: "C:\\Users\\shaowenjie\\.zcode\\cli-config.json",
        lastScanAt: nowSec(),
      });
    },
    upsert_mcp_server: function (args) {
      var summary = {
        name: args.name,
        transport: args.transport,
        enabled: args.enabled,
        sourcePath: "C:\\Users\\shaowenjie\\.zcode\\cli-config.json",
        command: args.command ?? null,
        args: args.args ?? [],
        url: args.url ?? null,
        headers: args.headers ?? {},
        environment: args.environment ?? {},
      };
      var idx = mcpServers.findIndex(function (s) {
        return s.name === args.name;
      });
      if (idx >= 0) mcpServers[idx] = summary;
      else mcpServers.push(summary);
      return ok({ server: summary, total: mcpServers.length, sourcePath: summary.sourcePath });
    },
    set_mcp_server_enabled: function (args) {
      var s = mcpServers.find(function (x) {
        return x.name === args.name;
      });
      if (s) s.enabled = args.enabled;
      return ok({ server: s, total: mcpServers.length, sourcePath: "C:\\Users\\shaowenjie\\.zcode\\cli-config.json" });
    },
    remove_mcp_server: function (args) {
      mcpServers = mcpServers.filter(function (s) {
        return s.name !== args.name;
      });
      return ok({
        removedName: args.name,
        total: mcpServers.length,
        sourcePath: "C:\\Users\\shaowenjie\\.zcode\\cli-config.json",
      });
    },

    // ---------- Skills ----------
    load_installed_skills: function () {
      return ok({
        items: skills,
        total: skills.length,
        rootPath: "C:\\Users\\shaowenjie\\.zcode\\skills",
        lastScanAt: nowSec(),
      });
    },
    load_skill_backups: function () {
      return ok({
        items: skillBackups,
        total: skillBackups.length,
        rootPath: "C:\\Users\\shaowenjie\\.zcode\\zmate\\backups\\skills",
        lastScanAt: nowSec(),
      });
    },
    import_skill: function (args) {
      var name = (args.sourcePath.split(/[\\/]/).pop() || "imported-skill").toLowerCase();
      var replaced = skills.some(function (s) {
        return s.id === name;
      });
      var skill = {
        id: name,
        name: name,
        title: name,
        summary: "从 " + args.sourcePath + " 导入",
        relativePath: "skills/" + name,
        directoryPath: "C:\\Users\\shaowenjie\\.zcode\\skills\\" + name,
        skillFilePath: "C:\\Users\\shaowenjie\\.zcode\\skills\\" + name + "\\SKILL.md",
        updatedAt: nowSec(),
      };
      if (!replaced) skills.push(skill);
      return ok({
        skill: skill,
        replacedExisting: replaced,
        backup: replaced
          ? {
              id: "backup-" + nowSec(),
              skillID: name,
              name: name,
              title: name,
              relativePath: "backups/skills/" + name,
              backupPath: "C:\\Users\\shaowenjie\\.zcode\\zmate\\backups\\skills\\" + name,
              createdAt: nowSec(),
            }
          : null,
      });
    },
    remove_skill: function (args) {
      var s = skills.find(function (x) {
        return x.id === args.skillId;
      });
      skills = skills.filter(function (x) {
        return x.id !== args.skillId;
      });
      var backup = {
        id: "backup-" + nextBackupId++,
        skillID: args.skillId,
        name: args.skillId,
        title: s ? s.title : args.skillId,
        relativePath: "backups/skills/" + args.skillId,
        backupPath: "C:\\Users\\shaowenjie\\.zcode\\zmate\\backups\\skills\\" + args.skillId,
        createdAt: nowSec(),
      };
      skillBackups.push(backup);
      return ok({ removedSkillID: args.skillId, backup: backup, remainingInstalledCount: skills.length });
    },
    restore_skill_backup: function (args) {
      var b = skillBackups.find(function (x) {
        return x.id === args.backupId;
      });
      var restored = {
        id: b.skillID,
        name: b.skillID,
        title: b.title,
        summary: "从备份恢复",
        relativePath: "skills/" + b.skillID,
        directoryPath: "C:\\Users\\shaowenjie\\.zcode\\skills\\" + b.skillID,
        skillFilePath: "C:\\Users\\shaowenjie\\.zcode\\skills\\" + b.skillID + "\\SKILL.md",
        updatedAt: nowSec(),
      };
      skills.push(restored);
      skillBackups = skillBackups.filter(function (x) {
        return x.id !== args.backupId;
      });
      return ok({ restoredSkill: restored, backup: b, rollbackBackup: null });
    },
    delete_skill_backup: function (args) {
      skillBackups = skillBackups.filter(function (x) {
        return x.id !== args.backupId;
      });
      return ok({ deletedBackupID: args.backupId, remainingBackupCount: skillBackups.length });
    },

    // ---------- Custom instructions ----------
    load_custom_instruction_state: function () {
      return ok(instructionState);
    },
    preview_custom_instruction_apply: function (args) {
      return ok({
        globalPath: instructionState.current.globalPath,
        protectionState: instructionState.current.protectionState,
        issueMessage: null,
        currentManagedContent: instructionState.current.managedContent,
        nextManagedContent: args.content,
        resultingContent:
          "用户自有内容……\n<!-- ZMATE_GLOBAL_BEGIN -->\n" + args.content + "\n<!-- ZMATE_GLOBAL_END -->\n更多自有内容",
      });
    },
    apply_custom_instruction: function (args) {
      instructionState.current.managedContent = args.content;
      instructionState.current.managedBlockPresent = true;
      instructionState.current.lastAppliedAt = nowSec();
      instructionState.current.lastTemplateCode = args.templateCode ?? null;
      instructionState.current.lastTemplateTitle = args.templateTitle ?? null;
      instructionState.history.unshift({
        id: "hist-" + nowSec(),
        createdAt: nowSec(),
        action: "apply",
        source: args.source ?? "manual",
        templateCode: args.templateCode ?? null,
        templateTitle: args.templateTitle ?? null,
      });
      return ok(instructionState);
    },
    clear_custom_instruction_block: function () {
      instructionState.current.managedBlockPresent = false;
      instructionState.current.managedContent = "";
      instructionState.history.unshift({
        id: "hist-" + nowSec(),
        createdAt: nowSec(),
        action: "clear",
        source: "manual",
        templateCode: null,
        templateTitle: null,
      });
      return ok(instructionState);
    },
    rollback_custom_instruction: function (args) {
      instructionState.history.unshift({
        id: "hist-" + nowSec(),
        createdAt: nowSec(),
        action: "rollback",
        source: "manual",
        templateCode: null,
        templateTitle: null,
      });
      return ok(instructionState);
    },

    // ---------- Sessions ----------
    list_sessions: function (args) {
      var q = (args.query || "").toLowerCase();
      var items = sessions.filter(function (s) {
        if (!args.includeArchived && s.archived) return false;
        if (q && s.title.toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
      var offset = args.offset || 0;
      var limit = args.limit || 50;
      return ok({
        items: items.slice(offset, offset + limit),
        total: items.length,
        sourcePath: "C:\\Users\\shaowenjie\\.zcode\\tasks.db",
        dbExists: true,
        lastScanAt: nowSec(),
      });
    },
    get_session_overview: function () {
      return ok({ totalSessions: 87, storageBytes: 50663424, activeDays: 46, avgPerActiveDay: 1.9 });
    },
    get_session_detail: function (args) {
      var s = sessions.find(function (x) {
        return x.taskId === args.taskId;
      });
      return ok({
        taskId: args.taskId,
        title: s ? s.title : "未知会话",
        directory: s ? s.workspacePath : null,
        version: "0.1.0",
        messages: sessionMessages(args.taskId),
        truncated: false,
      });
    },
    get_session_stats: function (args) {
      return ok({
        taskId: args.taskId,
        requestCount: 14,
        inputTokens: 48200,
        outputTokens: 12600,
        reasoningTokens: 4300,
        cacheReadTokens: 22400,
        totalDurationMs: 1840000,
        toolCallCount: 23,
        firstRequestAt: nowSec() - 86400,
        lastRequestAt: nowSec() - 3600,
      });
    },
    export_sessions: function (args) {
      emitEvent("session-transfer-progress", { stage: "export", done: 1, total: 3 });
      setTimeout(function () {
        emitEvent("session-transfer-progress", { stage: "export", done: 3, total: 3 });
      }, 300);
      return ok({
        exported: args.taskIds.length,
        missingTaskIds: [],
        filePath: args.outPath,
        fileBytes: 284211,
      });
    },
    inspect_session_zip: function () {
      return ok({
        format: "zmate-session-transfer",
        version: 1,
        exportedAt: nowSec() - 3600,
        total: 3,
        items: [
          {
            taskId: "task-001",
            title: "重构仪表盘趋势图组件",
            workspacePath: "C:\\proj\\ZMate",
            updatedAt: nowMs() - 7200000,
            messageCount: 5,
            bodyExists: true,
            existsLocally: true,
          },
          {
            taskId: "task-100",
            title: "旧机器上的会话 A",
            workspacePath: "D:\\work\\legacy",
            updatedAt: nowMs() - 86400000 * 12,
            messageCount: 18,
            bodyExists: true,
            existsLocally: false,
          },
          {
            taskId: "task-101",
            title: "旧机器上的会话 B",
            workspacePath: null,
            updatedAt: nowMs() - 86400000 * 20,
            messageCount: 9,
            bodyExists: true,
            existsLocally: false,
          },
        ],
      });
    },
    import_sessions: function (args) {
      emitEvent("session-transfer-progress", { stage: "import", done: 1, total: 3 });
      setTimeout(function () {
        emitEvent("session-transfer-progress", { stage: "import", done: 3, total: 3 });
      }, 300);
      return ok({
        imported: 2,
        skipped: args.mode === "skip" ? 1 : 0,
        backupDir: "C:\\Users\\shaowenjie\\.zcode\\zmate\\backups\\session-import",
      });
    },

    // ---------- System ----------
    load_app_state: function () {
      return ok({
        zcodeHome: "C:\\Users\\shaowenjie\\.zcode",
        providerConfigPath: "C:\\Users\\shaowenjie\\.zcode\\provider_config.json",
        cliConfigPath: "C:\\Users\\shaowenjie\\.zcode\\cli-config.json",
        skillsDir: "C:\\Users\\shaowenjie\\.zcode\\skills",
        agentsMdPath: "C:\\Users\\shaowenjie\\.zcode\\AGENTS.md",
        tasksDbPath: "C:\\Users\\shaowenjie\\.zcode\\tasks.db",
        sessionDbPath: "C:\\Users\\shaowenjie\\.zcode\\sessions.db",
        appDataDir: "C:\\Users\\shaowenjie\\AppData\\Roaming\\zmate",
        settings: state.settings,
        zcodeRunning: true,
      });
    },
    set_check_zcode_running: function (args) {
      state.settings.checkZcodeRunning = args.enabled;
      return ok(state.settings);
    },
    is_zcode_running: function () {
      return ok(true);
    },
    load_zcode_proxy: function () {
      return ok({
        enabled: state.proxy.enabled,
        port: state.proxy.port,
        proxyUrl: state.proxy.enabled ? "http://127.0.0.1:" + (state.proxy.port || "7890") : null,
        isLocal: true,
        sourcePath: "C:\\Users\\shaowenjie\\.zcode\\setting.json",
      });
    },
    set_zcode_proxy: function (args) {
      state.proxy.enabled = args.input.enabled;
      state.proxy.port = args.input.port;
      return ok({
        enabled: state.proxy.enabled,
        port: state.proxy.port,
        proxyUrl: state.proxy.enabled ? "http://127.0.0.1:" + (state.proxy.port || "7890") : null,
        isLocal: true,
        sourcePath: "C:\\Users\\shaowenjie\\.zcode\\setting.json",
      });
    },
    restart_zcode: function () {
      return ok(undefined);
    },
    diagnose: function () {
      return ok({
        zcodeHome: "C:\\Users\\shaowenjie\\.zcode",
        coreVersion: "2.6.3",
        os: "windows",
        arch: "x86_64",
        zcodeRunning: true,
        pathChecks: [
          { key: "zcodeHome", path: "C:\\Users\\shaowenjie\\.zcode", exists: true },
          { key: "providerConfig", path: "C:\\Users\\shaowenjie\\.zcode\\provider_config.json", exists: true },
          { key: "cliConfig", path: "C:\\Users\\shaowenjie\\.zcode\\cli-config.json", exists: true },
          { key: "skillsDir", path: "C:\\Users\\shaowenjie\\.zcode\\skills", exists: true },
          { key: "agentsMd", path: "C:\\Users\\shaowenjie\\.zcode\\AGENTS.md", exists: true },
          { key: "tasksDb", path: "C:\\Users\\shaowenjie\\.zcode\\tasks.db", exists: true },
        ],
        providerConfigValid: true,
        providerConfigError: null,
        cliConfigValid: true,
        cliConfigError: null,
        sessionDbExists: true,
        tasksDbExists: true,
      });
    },
    clean: function () {
      return ok({ providerBackupsRemoved: 6, skillBackupsRemoved: 0, instructionHistoryRemoved: 2 });
    },
    check_update_installability: function () {
      return {
        canInstall: true,
        code: "ok",
        executablePath: "C:\\Program Files\\ZMate\\ZMate.exe",
        bundlePath: null,
        translocated: false,
        quarantined: false,
      };
    },
    graceful_restart_for_update: function () {
      return undefined;
    },
    open_path: function () {
      return undefined;
    },
    get_system_info: function () {
      return { os: "windows", osVersion: "10.0.26200", arch: "x86_64", hostname: "MOCK-PC" };
    },
    load_dashboard: function () {
      if (!dashboardCache) dashboardCache = buildDashboard();
      return ok(dashboardCache);
    },
  };

  // ------------------------------------------------------------------
  // __TAURI_INTERNALS__
  // ------------------------------------------------------------------
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
      currentWebviewWindow: { label: "main" },
    },
    transformCallback: function (callback, once) {
      var id = nextCbId++;
      callbacks.set(id, { fn: callback, once: !!once });
      return id;
    },
    unregisterCallback: function (id) {
      callbacks.delete(id);
    },
    convertFileSrc: function (filePath) {
      return filePath;
    },
    invoke: function (cmd, args) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          try {
            if (failOnce[cmd]) {
              delete failOnce[cmd];
              reject(new Error("Mock 注入的失败(命令:" + cmd + ")"));
              return;
            }
            // 事件插件
            if (cmd === "plugin:event|listen") {
              eventBindings.push({ event: args.event, cbId: args.handler });
              resolve(nextEventId++);
              return;
            }
            if (cmd === "plugin:event|unlisten") {
              eventBindings = eventBindings.filter(function (b) {
                return !(b.event === args.event && b.cbId === args.id);
              });
              resolve(null);
              return;
            }
            if (cmd === "plugin:event|emit") {
              emitEvent(args.event, args.payload);
              resolve(null);
              return;
            }
            // 核心命令
            if (handlers[cmd]) {
              resolve(handlers[cmd](args || {}));
              return;
            }
            // 对话框插件:返回固定假路径
            if (cmd === "plugin:dialog|open") {
              resolve("C:\\Users\\shaowenjie\\.zcode\\mock-selected.zip");
              return;
            }
            if (cmd === "plugin:dialog|save") {
              resolve("C:\\Users\\shaowenjie\\Desktop\\zmate-sessions-mock.zip");
              return;
            }
            if (cmd === "plugin:dialog|message" || cmd === "plugin:dialog|ask") {
              resolve(true);
              return;
            }
            if (cmd === "plugin:dialog|confirm") {
              resolve(true);
              return;
            }
            // 其余插件(updater/shell/process/window/app)一律空响应
            if (cmd.indexOf("plugin:") === 0) {
              console.info("[zmate-mock] 插件命令兜底:", cmd, args);
              resolve(null);
              return;
            }
            reject(new Error("[zmate-mock] 未实现的命令: " + cmd));
          } catch (e) {
            reject(e);
          }
        }, 120 + Math.floor(Math.random() * 160));
      });
    },
  };

  // 测试辅助句柄
  window.__ZMATE_MOCK__ = {
    emitEvent: emitEvent,
    failNext: function (cmd) {
      failOnce[cmd] = true;
    },
    state: state,
    handlers: handlers,
  };

  console.info("[zmate-mock] Tauri IPC mock 已启用,共", Object.keys(handlers).length, "个核心命令");
})();
