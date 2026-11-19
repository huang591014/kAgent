import { randomBytes } from "node:crypto";

export const newTaskId = (): string => `task_${randomBytes(8).toString("hex")}`;
export const newRequestId = (): string => `req_${randomBytes(6).toString("hex")}`;
export const newBatchId = (): string => `run_${randomBytes(8).toString("hex")}`;
export const newEventSeq = () => 0;
