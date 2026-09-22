/** Tiny display-text helpers shared by convert.ts's warning messages — kept separate so warning wording changes don't touch conversion logic. */
export function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function describeCount(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${pluralize(count, singular, plural)}`;
}
