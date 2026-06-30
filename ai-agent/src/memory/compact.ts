export class CompactEngine {
  private maxMessages: number;
  constructor(maxMessages = 30) { this.maxMessages = maxMessages; }
  shouldCompact(messageCount: number): boolean { return messageCount > this.maxMessages; }
}
