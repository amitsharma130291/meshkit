/** Tiny display-text helpers for the converter page — kept separate so wording changes never touch conversion logic. */
export function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function describeCount(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${pluralize(count, singular, plural)}`;
}
