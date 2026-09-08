import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CHAPTERS, chapterBySlug } from "@/lib/guide";
import ChapterPage, { chapterMetadata } from "../chapter";

type Params = { params: Promise<{ slug: string }> };

/** Every chapter is generated at build time; an unknown slug is a 404, never a filesystem read. */
export const dynamicParams = false;

export function generateStaticParams() {
  return CHAPTERS.filter((c) => c.slug !== "").map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const c = chapterBySlug((await params).slug);
  return c ? chapterMetadata(c) : {};
}

export default async function GuideChapter({ params }: Params) {
  const c = chapterBySlug((await params).slug);
  if (!c || c.slug === "") notFound();
  return <ChapterPage chapter={c} />;
}
