export class ToolRegistry {
  private tools: Map<string, (args: any) => Promise<any>> = new Map();
  private defs: any[] = [];
  register(name: string, handler: (args: any) => Promise<any>, def: any): void {
    this.tools.set(name, handler); this.defs.push(def);
  }
  async execute(name: string, args: any): Promise<any> {
    const h = this.tools.get(name); if (!h) throw new Error(`Unknown tool: ${name}`);
    return h(args);
  }
  getToolDefs(): any[] { return this.defs.map(d => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.parameters } })); }
}
