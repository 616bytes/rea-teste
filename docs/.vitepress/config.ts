import { defineConfig } from "vitepress";

export default defineConfig({
  title: "REA",
  description:
    "Reverse engineer binaries, applications, and runtime behavior with one CLI and MCP server.",
  lang: "en-US",
  base: "/rea/",
  srcExclude: ["readme/**"],
  themeConfig: {
    nav: [
      { text: "Get started", link: "/installation" },
      { text: "Reference", link: "/mcp-contracts" },
      { text: "Roadmap", link: "/roadmap" },
    ],
    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Installation and setup", link: "/installation" },
          { text: "Client configuration", link: "/client-configuration" },
          { text: "CLI and Evidence", link: "/cli" },
          { text: "Agent prompts", link: "/mcp-prompts" },
          { text: "Roadmap", link: "/roadmap" },
        ],
      },
      {
        text: "Native binaries",
        collapsed: false,
        items: [
          { text: "Native investigation", link: "/native-investigation" },
          { text: "Go build metadata", link: "/go-binaries" },
          { text: "Rust dependencies", link: "/rust-binaries" },
          { text: "Offline ELF layout", link: "/binary-diagnostics" },
          { text: "Recorded crashes", link: "/recorded-crashes" },
          {
            text: "objdump, GDB and Rizin",
            link: "/reverse-engineering-tools",
          },
        ],
      },
      {
        text: "JavaScript and Electron",
        collapsed: false,
        items: [
          {
            text: "Static analysis",
            link: "/javascript-artifact-reconstruction",
          },
          {
            text: "JavaScript workflows",
            link: "/javascript-application-workflows",
          },
          {
            text: "Application graph",
            link: "/javascript-application-graph",
          },
          { text: "Source recovery", link: "/javascript-recovery" },
          {
            text: "Runtime attribution",
            link: "/javascript-runtime-observation",
          },
          {
            text: "Static/runtime reconciliation",
            link: "/javascript-runtime-reconciliation",
          },
          { text: "Electron observation", link: "/electron-observation" },
          { text: "Electron fuses", link: "/electron-fuses" },
        ],
      },
      {
        text: "Websites and browsers",
        collapsed: false,
        items: [
          { text: "Browser observation", link: "/browser-observation" },
          { text: "Browser scenarios", link: "/browser-scenario-contract" },
          { text: "Runtime source attribution", link: "/web-runtime" },
          {
            text: "Web network captures",
            link: "/web-network-captures",
          },
          { text: "Captured source locations", link: "/web-source-location" },
          { text: "Captured module traces", link: "/website-module-trace" },
          { text: "Captured script export", link: "/website-script-export" },
        ],
      },
      {
        text: "Packages, mobile and firmware",
        collapsed: false,
        items: [
          { text: ".NET assemblies", link: "/managed-code-analysis" },
          { text: "Android applications", link: "/android-analysis" },
          { text: "Apktool resources", link: "/apktool-resource-analysis" },
          { text: "ADB devices", link: "/adb-device-analysis" },
          { text: "Flutter builds", link: "/flutter-analysis" },
          { text: "Apple applications", link: "/apple-application-analysis" },
          { text: "HarmonyOS packages", link: "/harmony-analysis" },
          { text: "Firmware", link: "/firmware-analysis" },
          { text: "WebAssembly artifacts", link: "/wasm-artifacts" },
          { text: "EVM bytecode", link: "/evm-bytecode" },
        ],
      },
      {
        text: "Recordings and runtime",
        collapsed: false,
        items: [
          { text: "SQLite databases", link: "/sqlite-databases" },
          { text: "Packet captures", link: "/packet-captures" },
          { text: "Packet summaries", link: "/pcap-analysis" },
          { text: "Signal recordings", link: "/signal-recordings" },
          { text: "Process capture", link: "/process-capture" },
          { text: "Frida instrumentation", link: "/frida-instrumentation" },
        ],
      },
      {
        text: "Provider guides",
        collapsed: true,
        items: [
          { text: "Ghidra semantics", link: "/ghidra-provider" },
          { text: "Ghidra on Windows", link: "/windows-ghidra-p0" },
          { text: "Ghidra DOS analysis", link: "/ghidra-dos" },
          { text: "Ghidra raw binary", link: "/raw-binary" },
          { text: "Ghidra MIPS", link: "/ghidra-mips" },
          { text: "Ghidra PSP", link: "/ghidra-psp" },
          { text: "Ghidra RISC-V", link: "/ghidra-riscv" },
          { text: "Ghidra PowerPC", link: "/ghidra-ppc" },
          { text: "Ghidra NativeAOT", link: "/ghidra-nativeaot" },
          { text: "IDA", link: "/ida-provider" },
          { text: "Kuna", link: "/kuna-provider" },
          { text: "JEB", link: "/jeb-analysis" },
        ],
      },
      {
        text: "Reference and development",
        collapsed: true,
        items: [
          { text: "MCP contracts", link: "/mcp-contracts" },
          {
            text: "Obligation ledgers",
            link: "/reconstruction-obligation-ledgers",
          },
          {
            text: "Reconstruction coverage",
            link: "/reconstruction-coverage",
          },
          { text: "Tool design", link: "/tool-design" },
          { text: "Testing", link: "/testing" },
          { text: "Client verification", link: "/client-verification" },
          {
            text: "Reconstruction readiness",
            link: "/reconstruction-readiness",
          },
          { text: "HTTP/3 capture lab", link: "/http3-capture-lab" },
          { text: "Releasing", link: "/releasing" },
          { text: "6.2 migration", link: "/migration-6.2" },
        ],
      },
    ],
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/morluto/rea" },
      { icon: "discord", link: "https://discord.gg/GkcryMnJDM" },
    ],
    editLink: {
      pattern: "https://github.com/morluto/rea/edit/main/docs/:path",
    },
    footer: {
      message: "Released under the MIT License.",
    },
  },
});
