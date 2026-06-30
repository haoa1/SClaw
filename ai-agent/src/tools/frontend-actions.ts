export const frontendActions: Array<{ type: string; payload: any }> = [];
export function clearActions(): void { frontendActions.length = 0; }
export function registerFrontendTools(registry: any): void {
  registry.register("run_screen", async (args: any) => {
    frontendActions.push({ type: "run_screen", payload: args });
    return JSON.stringify({ status: "ok", action: "run_screen" });
  }, { name: "run_screen", description: "Run stock screen", parameters: { type: "object", properties: { strategies: { type: "string" } } } });
}
