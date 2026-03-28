export function toPlainTextForSpeech(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
