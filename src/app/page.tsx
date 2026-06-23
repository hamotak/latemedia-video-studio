import { redirect } from "next/navigation";

export default function HomePage() {
  // Standalone build: no login. Land straight in the Video studio.
  redirect("/studio/video");
}
