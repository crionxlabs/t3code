// @ts-check
// Registers loader.mjs so T3 Code's Node scripts (the dev launcher, the build
// scripts) load with AdelisOne's overrides. vite.mjs adds this to NODE_OPTIONS
// for processes started from T3's builds; scripts/dist.mjs passes it directly.
import * as NodeModule from "node:module";

NodeModule.register("./loader.mjs", import.meta.url);
