import { useI18n } from '@/client/i18n/index.js';
import { guideCategories } from '@/client/routes/route-config.js';
import { getAllGuideMeta } from '@/client/data/index.js';
import { getGuideIcon } from '@/client/utils/guideIcons.js';
import { Link } from 'react-router-dom';

// ---------------------------------------------------------------------------
// LandingPage — pi-maestro-flow feature overview home page
// ---------------------------------------------------------------------------

interface Feature {
  icon: string;
  zh: { title: string; desc: string };
  en: { title: string; desc: string };
  guide?: string;
}

const FEATURES: Feature[] = [
  {
    icon: 'shuffle',
    zh: { title: '并行多智能体调度', desc: '一次派出多个子进程智能体并行工作，支持 DAG 依赖图、结构化输出与模型路由' },
    en: { title: 'Parallel Multi-Agent Dispatch', desc: 'Fan out subprocess agents, DAG dependencies, structured output, model routing' },
    guide: 'teammate-dispatch',
  },
  {
    icon: 'compass',
    zh: { title: 'Goal 自主长时目标', desc: '设定目标与 Token 预算，跨多轮自主循环，完成后由独立验证器审计' },
    en: { title: 'Goal Long-Running Objectives', desc: 'Budgeted autonomous loops with independent completion verification' },
    guide: 'goal-plan-todo',
  },
  {
    icon: 'clipboard-list',
    zh: { title: 'Plan 先批准再动手', desc: '只读起草 Markdown 计划，用户批准后才放行编辑；支持独立 Plan 模型' },
    en: { title: 'Plan-Before-Act', desc: 'Read-only drafted plans that require approval before any edit is allowed' },
    guide: 'goal-plan-todo',
  },
  {
    icon: 'palette',
    zh: { title: 'Pi Cockpit 可视化', desc: '编辑器上方实时状态堆栈 + Starship 风格 Footer，内置 9 套主题与 Quiet 模式' },
    en: { title: 'Pi Cockpit Visualization', desc: 'Live status stack + Starship-style footer, 9 themes, Quiet mode' },
    guide: 'cockpit',
  },
  {
    icon: 'brain',
    zh: { title: '持久化知识系统', desc: '语义搜索、Spec 规范与 Knowhow 经验沉淀，跨会话存活' },
    en: { title: 'Persistent Knowledge System', desc: 'Semantic search, specs & knowhow accumulation that survives across sessions' },
    guide: 'knowledge',
  },
  {
    icon: 'link',
    zh: { title: '全协议连接', desc: 'MCP 客户端（含 OAuth 自动认证）· LSP · 浏览器控制（CDP）· 网络搜索/深度研究' },
    en: { title: 'Full-Protocol Connectivity', desc: 'MCP (with OAuth), LSP, browser (CDP), web search & deep research' },
    guide: 'mcp',
  },
  {
    icon: 'lock',
    zh: { title: '权限控制', desc: '5 种模式（默认 YOLO），细粒度 allow/ask/deny，子进程权限中继' },
    en: { title: 'Permission Control', desc: 'Five modes (YOLO default), granular allow/ask/deny, IPC relay to subprocesses' },
    guide: 'permissions',
  },
  {
    icon: 'hook',
    zh: { title: 'Codex 兼容 Hooks', desc: '项目级钩子系统，内置安装器与信任审查' },
    en: { title: 'Codex-Compatible Hooks', desc: 'Project-level hooks with built-in installer and trust review' },
    guide: 'hooks-keybindings',
  },
  {
    icon: 'terminal',
    zh: { title: 'bash_bg 自适应 Shell', desc: '长命令超时自动转后台，完成时推送通知，不阻塞对话' },
    en: { title: 'Adaptive bash_bg Shell', desc: 'Long commands auto-background with completion notifications' },
    guide: 'bash-bg-observe',
  },
  {
    icon: 'eye',
    zh: { title: 'observe 阻塞观察', desc: 'status / wait / watch 三态观察，支持终态阻塞等待' },
    en: { title: 'Blocking observe', desc: 'status / wait / watch with terminal-state blocking' },
    guide: 'bash-bg-observe',
  },
  {
    icon: 'gauge',
    zh: { title: 'Compaction 容量管理', desc: '主动压缩阈值、链接阈值推导、摘要输出预算，防止上下文窗口溢出' },
    en: { title: 'Compaction Capacity Management', desc: 'Proactive thresholds, link derivation, summary budgets against overflow' },
    guide: 'compaction-config',
  },
  {
    icon: 'refresh-cw',
    zh: { title: '模型熔断与故障转移', desc: '电路断路器保护 API 调用，自动故障转移到备用模型；重试策略可配（最多 12 次）' },
    en: { title: 'Model Failover & Circuit Breaker', desc: 'Breaker-protected API calls with automatic fallback and retry policy' },
    guide: 'api-provider-config',
  },
  {
    icon: 'bot',
    zh: { title: 'Vision 多模态委托', desc: '纯文本主模型自动激活 describe_image，委托多模态模型分析图片' },
    en: { title: 'Vision Multimodal Delegation', desc: 'Text-only models auto-delegate image analysis to multimodal models' },
    guide: 'vision-config',
  },
  {
    icon: 'mail',
    zh: { title: 'Mailbox 消息队列', desc: '工作区级隔离的持久消息队列，冷恢复同步' },
    en: { title: 'Mailbox Message Queue', desc: 'Workspace-isolated persistent queue with cold-recovery sync' },
    guide: 'mailbox-session',
  },
  {
    icon: 'users',
    zh: { title: '32 个 Agent 角色', desc: '7 内置 + 25 项目级角色；逐任务思考深度控制（off → xhigh）' },
    en: { title: '32 Agent Roles', desc: '7 built-in + 25 project roles; per-task thinking depth off → xhigh' },
    guide: 'agents',
  },
  {
    icon: 'search',
    zh: { title: '网络搜索与深度研究', desc: 'smart_search 三模式（search / research / fetch），双路径自动降级' },
    en: { title: 'Web Search & Deep Research', desc: 'search / research / fetch modes with dual-path automatic fallback' },
    guide: 'smart-search',
  },
  {
    icon: 'sparkles',
    zh: { title: 'self-evolve 自进化（M1-M5）', desc: '运行轨迹 → 知识沉淀闭环：候选信号、健康侧车、提案治理与 canary 验证（默认禁用）' },
    en: { title: 'Self-Evolve Automation (M1-M5)', desc: 'Trajectory-to-knowledge loop: candidate signals, health sidecar, proposal governance, canary verification (opt-in)' },
  },
];

export default function LandingPage() {
  const { t, locale } = useI18n();
  const isZh = locale === 'zh-CN';

  return (
    <div>
      {/* Hero section */}
      <div className="mb-[var(--spacing-10)]">
        <div className="flex items-center gap-[var(--spacing-3)] mb-[var(--spacing-3)]">
          <span className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-lg)] bg-accent-blue">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </span>
          <h1 className="text-[42px] font-[var(--font-weight-medium)] text-text-primary leading-[1.2] tracking-[var(--letter-spacing-tight)]">
            {isZh ? 'pi maestro flow 功能与配置文档' : 'pi maestro flow Docs'}
          </h1>
        </div>
        <p className="text-[length:var(--font-size-md)] text-text-secondary leading-[1.75] max-w-[640px]">
          {isZh
            ? 'Pi 编码智能体的多智能体编排层 — 将一个只能串行干活的智能体，变成一支能并行调度、自主长跑、先规划后动手、全程可视的工程团队，并自带跨会话的持久化知识系统。'
            : 'The multi-agent orchestration layer for the Pi coding agent — turning a single serial agent into an engineering team that dispatches in parallel, runs long objectives, plans before acting, and stays fully visible.'}
        </p>
        <div className="flex items-center gap-[var(--spacing-3)] mt-[var(--spacing-5)]">
          <Link
            to="/quick-start"
            className="inline-flex items-center gap-[var(--spacing-2)] px-[var(--spacing-4)] py-[var(--spacing-2)] bg-accent-blue text-white text-[length:var(--font-size-sm)] font-[var(--font-weight-semibold)] rounded-[var(--radius-default)] no-underline transition-all duration-[var(--duration-fast)] hover:brightness-110"
          >
            {getGuideIcon('rocket', 'w-4 h-4')}
            {isZh ? '快速开始' : 'Quick Start'}
          </Link>
          <Link
            to="/guides/install"
            className="inline-flex items-center gap-[var(--spacing-2)] px-[var(--spacing-4)] py-[var(--spacing-2)] bg-bg-card border border-border text-text-primary text-[length:var(--font-size-sm)] font-[var(--font-weight-medium)] rounded-[var(--radius-default)] no-underline transition-all duration-[var(--duration-fast)] hover:border-text-placeholder"
          >
            {getGuideIcon('download', 'w-4 h-4')}
            {isZh ? '安装指南' : 'Install Guide'}
          </Link>
        </div>
      </div>

      {/* Architecture callout — three layers */}
      <div className="mb-[var(--spacing-10)] p-[var(--spacing-6)] bg-bg-card border border-border rounded-[var(--radius-lg)]">
        <h2 className="text-[18px] font-[var(--font-weight-medium)] text-text-primary mb-[var(--spacing-3)]">
          {isZh ? '三插件分层架构' : 'Three-Plugin Architecture'}
        </h2>
        <p className="text-[length:var(--font-size-sm)] text-text-secondary leading-[1.7] mb-[var(--spacing-4)]">
          {isZh ? '装一个即得全部：' : 'One install gets all three:'}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-[var(--spacing-3)]">
          <ArchLayer
            name="pi-maestro-flow"
            role={isZh ? '编排层与安装入口' : 'Orchestration & entry'}
            desc={isZh ? '目标/任务/计划、知识系统、MCP/LSP/浏览器/搜索' : 'Goals, tasks, plans, knowledge, MCP/LSP/browser/search'}
            icon="layers"
          />
          <ArchLayer
            name="pi-maestro-teammate"
            role={isZh ? '执行引擎' : 'Execution engine'}
            desc={isZh ? '并行子进程智能体、DAG 依赖图、模型路由' : 'Parallel subprocess agents, DAG graphs, model routing'}
            icon="shuffle"
          />
          <ArchLayer
            name="pi-cockpit"
            role={isZh ? '可视化状态' : 'Visualization'}
            desc={isZh ? '编辑器上方实时状态堆栈 + Starship 风格 Footer' : 'Live status stack above the editor + Starship footer'}
            icon="palette"
          />
        </div>
      </div>

      {/* Feature grid */}
      <div className="mb-[var(--spacing-10)]">
        <h2 className="text-[18px] font-[var(--font-weight-medium)] text-text-primary mb-[var(--spacing-4)]">
          {isZh ? '核心特性' : 'Core Features'}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--spacing-3)]">
          {FEATURES.map((f) => (
            <FeatureCard key={f.zh.title} feature={f} isZh={isZh} />
          ))}
        </div>
      </div>

      {/* Guide categories */}
      <div className="mb-[var(--spacing-10)]">
        <h2 className="text-[18px] font-[var(--font-weight-medium)] text-text-primary mb-[var(--spacing-4)]">
          {isZh ? '浏览文档' : 'Browse the Docs'}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--spacing-3)]">
          {guideCategories.map((cat) => {
            const catGuides = getAllGuideMeta().filter((g) => g.category === cat.id);
            return (
              <Link
                key={cat.id}
                to="/guides"
                className="block p-[var(--spacing-4)] bg-bg-card border border-border rounded-[var(--radius-lg)] no-underline transition-all duration-[var(--duration-fast)] hover:border-text-placeholder hover:-translate-y-[1px] hover:shadow-[var(--shadow-sm)]"
              >
                <div className="flex items-center justify-between mb-[var(--spacing-1)]">
                  <h3 className="text-[length:var(--font-size-sm)] font-[var(--font-weight-semibold)] text-text-primary">
                    {isZh ? cat.title_zh : cat.title}
                  </h3>
                  <span className="text-[length:11px] text-text-tertiary">{catGuides.length} 篇</span>
                </div>
                <p className="text-[length:11px] text-text-secondary leading-[var(--line-height-normal)]">
                  {isZh ? cat.description_zh : cat.description}
                </p>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FeatureCard — Gemini CLI style: clean card with border
// ---------------------------------------------------------------------------

function FeatureCard({ feature, isZh }: { feature: Feature; isZh: boolean }) {
  const content = isZh ? feature.zh : feature.en;
  return (
    <div className="p-[var(--spacing-4)] bg-bg-card border border-border rounded-[var(--radius-lg)] transition-all duration-[var(--duration-fast)] hover:border-text-placeholder">
      <div className="flex items-start gap-[var(--spacing-3)]">
        <span className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-default)] bg-tint-purple text-accent-purple shrink-0">
          {getGuideIcon(feature.icon, 'w-4 h-4')}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-[var(--spacing-2)] mb-[var(--spacing-1)]">
            <h3 className="text-[length:var(--font-size-sm)] font-[var(--font-weight-semibold)] text-text-primary">
              {content.title}
            </h3>
            {feature.guide && (
              <Link
                to={`/guides/${feature.guide}`}
                className="shrink-0 text-[length:11px] text-accent-blue no-underline hover:underline"
              >
                →
              </Link>
            )}
          </div>
          <p className="text-[length:11px] text-text-secondary leading-[var(--line-height-normal)]">
            {content.desc}
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ArchLayer — three-layer architecture card
// ---------------------------------------------------------------------------

function ArchLayer({ name, role, desc, icon }: { name: string; role: string; desc: string; icon: string }) {
  return (
    <div className="p-[var(--spacing-4)] bg-bg-secondary border border-border rounded-[var(--radius-lg)]">
      <div className="flex items-center gap-[var(--spacing-2)] mb-[var(--spacing-2)]">
        <span className="flex items-center justify-center w-6 h-6 rounded-[var(--radius-default)] bg-tint-blue text-accent-blue">
          {getGuideIcon(icon, 'w-3 h-3')}
        </span>
        <div>
          <div className="text-[length:12px] font-[var(--font-weight-semibold)] text-text-primary font-mono">{name}</div>
          <div className="text-[length:10px] text-text-tertiary">{role}</div>
        </div>
      </div>
      <p className="text-[length:11px] text-text-secondary leading-[var(--line-height-normal)]">{desc}</p>
    </div>
  );
}
