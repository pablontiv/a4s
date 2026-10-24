/**
 * Unit test del entry src/index.ts.
 *
 * Regresión: KIRO_PROFILE_ARN se resolvía con una IIFE que lanzaba en tiempo
 * de import, y omp carga todas las extensiones al arrancar — sin el env var,
 * la extensión entera fallaba ("Failed to load extension"). La resolución es
 * lazy: el import y el registerProvider deben funcionar sin el env var.
 *
 * Offline y determinístico: no se invoca streamSimple ni fetchDynamicModels
 * (pueden tocar la red si hay credenciales reales en el store de kiro-cli).
 */
import { describe, expect, it } from "bun:test";

interface ProviderConfig {
	api: string;
	models: { id: string }[];
}
// Dynamic import (no static): el env debe limpiarse ANTES de cargar el módulo —
// el bug regresado era un throw top-level en tiempo de import.

describe("kiroExtension entry", () => {
	it("carga y registra el provider sin KIRO_PROFILE_ARN", async () => {
		delete process.env.KIRO_PROFILE_ARN;
		const mod = await import("../../src/index");
		const registered: { name: string; config: ProviderConfig }[] = [];
		const fakePi = {
			registerProvider: (name: string, config: ProviderConfig) => {
				registered.push({ name, config });
			},
		};
		mod.default(fakePi as never);
		expect(registered.length).toBe(1);
		expect(registered[0].name).toBe("kiro");
		expect(registered[0].config.api).toBe("kiro-streaming");
		expect(registered[0].config.models.length).toBeGreaterThan(0);
	});
});
