import { CHAPTERS } from "@/lib/guide";
import ChapterPage, { chapterMetadata } from "./chapter";

/** Chapter 1 lives at the bare /guide. Public and static (spec §10.2). */
export const metadata = chapterMetadata(CHAPTERS[0]!);

export default function GuideIndex() {
  return <ChapterPage chapter={CHAPTERS[0]!} />;
}
