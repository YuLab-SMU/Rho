/** Browser clipboard boundary. Invoked only from an explicit copy action. */
export const copyAgentText = (text: string): Promise<void> => navigator.clipboard.writeText(text);
