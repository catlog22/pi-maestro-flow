import { useI18n } from '@/client/i18n/index.js';
import { Link } from 'react-router-dom';
import { TerminalBlock } from '@/client/components/content/GuideComponents.js';

// ---------------------------------------------------------------------------
// QuickStartPage — Interactive single-page quick guide
// ---------------------------------------------------------------------------

export default function QuickStartPage() {
  const { locale } = useI18n();
  const isZh = locale === 'zh-CN';

  return (
    <div>
      {/* Header */}
      <div className="mb-[var(--spacing-8)]">
        <h1 className="text-[28px] font-[var(--font-weight-bold)] text-text-primary mb-[var(--spacing-2)] leading-[1.3]">
          {isZh ? '10 分钟快速入门' : '10-Minute Quick Start'}
        </h1>
        <p className="text-[length:var(--font-size-md)] text-text-secondary leading-[var(--line-height-relaxed)] max-w-[620px]">
          {isZh
            ? '安装 → 第一个并行任务 → 核心概念，最短路径上手 Maestro Flow。'
            : 'Install → first parallel task → core concepts. The shortest path to Maestro Flow.'}
        </p>
      </div>

      <div className="space-y-[var(--spacing-8)] max-w-[860px]">
        {/* Step 1 */}
        <Step
          n={1}
          title={isZh ? '安装' : 'Install'}
          desc={isZh
            ? '前置条件：Node.js ≥ 22.19.0 与 Pi Coding Agent ≥ 0.74.0。用 pi install 安装插件套件（teammate 与 cockpit 自动随附）。'
            : 'Prerequisites: Node.js ≥ 22.19.0 and Pi Coding Agent ≥ 0.74.0. Install the suite with pi install (teammate and cockpit come along automatically).'}
        >
          <TerminalBlock>
{`# 1. 安装宿主运行时（全局）
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# 2. 安装或升级插件（teammate + cockpit 自动注册）
pi install npm:pi-maestro-flow@0.14.2

# 3. 确认 Flow、Teammate 与 Cockpit 均已列出
pi list

# 4. 重启 Pi 或 reload extensions 后开始使用`}
          </TerminalBlock>
        </Step>

        {/* Step 2 */}
        <Step
          n={2}
          title={isZh ? '启动并派发第一个并行任务' : 'Start and Dispatch Your First Parallel Task'}
          desc={isZh
            ? '启动 Pi，用自然语言描述任务。Maestro Flow 自动分类意图并路由：简单任务直接执行，多步工程分解为链式计划逐步验证。也可以直接用 teammate 工具并行派出多个子智能体。'
            : 'Start Pi and describe your task in natural language. Maestro Flow classifies intent and routes automatically: simple tasks run directly, multi-step engineering decomposes into chained plans. Or dispatch multiple sub-agents in parallel with the teammate tool.'}
        >
          <TerminalBlock title="pi">
{`pi   # 启动，用自然语言描述任务即可`}
          </TerminalBlock>
          <TerminalBlock title="teammate 并行派发" compact>
{`teammate({
  tasks: [
    { name: "defs", agent: "explorer", prompt: "FIND: Auth 导出\\nSCOPE: src/auth/" },
    { name: "calls", agent: "explorer", prompt: "FIND: Auth 导入\\nSCOPE: src/" },
    { name: "report", agent: "general", prompt: "合并 {defs} + {calls} 生成缺口报告" }
  ]
})`}
          </TerminalBlock>
        </Step>

        {/* Step 3 */}
        <Step
          n={3}
          title={isZh ? '理解三个核心概念' : 'Three Core Concepts'}
          desc={isZh
            ? '理解编排层如何分层，是后续深入配置的基础。'
            : 'Understanding how the layers split is the foundation for deeper configuration.'}
        >
          <div className="space-y-[var(--spacing-3)]">
            <Concept
              icon="layers"
              title="Flow 编排层"
              enTitle="Flow orchestration"
              desc={isZh
                ? '目标（goal）、任务（todo）、计划（plan）、知识系统、MCP/LSP/浏览器连接 — 负责「编排与知识」。'
                : 'Goals, todos, plans, the knowledge system, and MCP/LSP/browser connectivity — "orchestration & knowledge".'}
            />
            <Concept
              icon="shuffle"
              title="Teammate 执行引擎"
              enTitle="Teammate execution"
              desc={isZh
                ? '并行子进程智能体、DAG 依赖图、模型路由与结构化输出 — 负责「并行执行」。'
                : 'Parallel subprocess agents, DAG graphs, model routing, structured output — "parallel execution".'}
            />
            <Concept
              icon="palette"
              title="Cockpit 可视化"
              enTitle="Cockpit visualization"
              desc={isZh
                ? '实时状态堆栈、Starship 风格 Footer、9 套主题、Quiet 模式 — 负责「看见」。'
                : 'Live status stack, Starship-style footer, 9 themes, Quiet mode — "seeing".'}
            />
          </div>
        </Step>

        {/* Step 4 */}
        <Step
          n={4}
          title={isZh ? '下一步' : 'Next Steps'}
          desc={isZh ? '按需深入各功能域与配置说明。' : 'Go deeper into each feature area and its configuration.'}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--spacing-2)]">
            <NextLink to="/guides/architecture" label={isZh ? '架构与核心概念' : 'Architecture & Concepts'} />
            <NextLink to="/guides/teammate-dispatch" label={isZh ? '并行多智能体调度' : 'Parallel Multi-Agent Dispatch'} />
            <NextLink to="/guides/goal-plan-todo" label={isZh ? 'Goal · Plan · todo' : 'Goals · Plans · Tasks'} />
            <NextLink to="/guides/settings-overview" label={isZh ? '设置系统总览' : 'Settings System Overview'} />
            <NextLink to="/guides/api-provider-config" label={isZh ? 'API Provider 配置' : 'API Provider Config'} />
            <NextLink to="/guides/compaction-config" label={isZh ? 'Compaction 配置' : 'Compaction Config'} />
          </div>
        </Step>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step — numbered section wrapper
// ---------------------------------------------------------------------------

function Step({ n, title, desc, children }: { n: number; title: string; desc: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-[var(--spacing-3)] mb-[var(--spacing-2)]">
        <span className="flex items-center justify-center w-7 h-7 rounded-full bg-accent-blue text-white text-[length:13px] font-[var(--font-weight-bold)] shrink-0">
          {n}
        </span>
        <h2 className="text-[length:var(--font-size-lg)] font-[var(--font-weight-semibold)] text-text-primary">
          {title}
        </h2>
      </div>
      <p className="text-[length:var(--font-size-sm)] text-text-secondary leading-[1.7] mb-[var(--spacing-3)]">
        {desc}
      </p>
      <div className="space-y-[var(--spacing-3)]">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Concept — architecture concept row
// ---------------------------------------------------------------------------

function Concept({ icon, title, enTitle, desc }: { icon: string; title: string; enTitle: string; desc: string }) {
  const { locale } = useI18n();
  return (
    <div className="flex items-start gap-[var(--spacing-3)] p-[var(--spacing-3)] bg-bg-card border border-border rounded-[var(--radius-default)]">
      <span className="flex items-center justify-center w-7 h-7 rounded-[var(--radius-default)] bg-tint-purple text-accent-purple shrink-0">
        <Icon name={icon} className="w-3.5 h-3.5" />
      </span>
      <div>
        <div className="text-[length:var(--font-size-sm)] font-[var(--font-weight-semibold)] text-text-primary">
          {locale === 'zh-CN' ? title : enTitle}
        </div>
        <p className="text-[length:11px] text-text-secondary leading-[var(--line-height-normal)] mt-[1px]">{desc}</p>
      </div>
    </div>
  );
}

function Icon({ name, className }: { name: string; className?: string }) {
  const paths: Record<string, React.ReactNode> = {
    layers: (
      <>
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </>
    ),
    shuffle: (
      <>
        <polyline points="16 3 21 3 21 8" />
        <line x1="4" y1="20" x2="21" y2="3" />
        <polyline points="21 16 21 21 16 21" />
        <line x1="15" y1="15" x2="21" y2="21" />
        <line x1="4" y1="4" x2="9" y2="9" />
      </>
    ),
    palette: (
      <>
        <circle cx="13.5" cy="6.5" r=".5" />
        <circle cx="17.5" cy="10.5" r=".5" />
        <circle cx="8.5" cy="7.5" r=".5" />
        <circle cx="6.5" cy="12.5" r=".5" />
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
      </>
    ),
  };
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// NextLink — next-step entry
// ---------------------------------------------------------------------------

function NextLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="flex items-center justify-between p-[var(--spacing-3)] bg-bg-card border border-border rounded-[var(--radius-default)] no-underline transition-all duration-[var(--duration-fast)] hover:border-text-placeholder hover:-translate-y-[1px]"
    >
      <span className="text-[length:var(--font-size-sm)] font-[var(--font-weight-medium)] text-text-primary">{label}</span>
      <svg className="w-3.5 h-3.5 text-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </Link>
  );
}
