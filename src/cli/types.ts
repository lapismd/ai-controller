export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode: 1 | 2 | 3 = 2,
  ) {
    super(message);
  }
}
