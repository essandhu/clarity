import type { Metadata } from "next";
import { ResumeView } from "@/components/resume/ResumeView";

export const metadata: Metadata = {
  title: "Clarity — Resume",
  description:
    "Build a local master profile and tailor a grounded resume to any role — nothing invented, nothing uploaded.",
};

export default function ResumePage() {
  return (
    <main className="page">
      <ResumeView />
    </main>
  );
}
