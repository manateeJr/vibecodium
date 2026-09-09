export function resumeFailureMessage(detail: string, prompt: string | undefined): string {
  return prompt === undefined
    ? `resume-failed: ${detail}`
    : `resume-failed: ${detail}; undelivered prompt: ${prompt}`;
}
