import { env } from "@/lib/env";
import { createApp } from "./app";

createApp().listen(env.PORT, () => {
  console.log(`IELTS platform API listening on http://localhost:${env.PORT}`);
});
