import { Hono } from "hono";
import { getAppUpdateStatus } from "../services/app-update-service";

const appUpdate = new Hono();

appUpdate.get("/", async (c) => {
  return c.json(await getAppUpdateStatus());
});

export default appUpdate;
