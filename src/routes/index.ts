import { Router } from "express";
import { authRouter } from "./auth";
import { studentRouter } from "./student";
import { examRouter } from "./exam";
import { passagesRouter } from "./passages";
import { audioRouter } from "./audio";
import { questionGroupsRouter } from "./question-groups";
import { questionsRouter } from "./questions";
import { mockTestsRouter } from "./mock-tests";
import { mediaRouter } from "./media";
import { adminRouter } from "./admin";
import { classesRouter } from "./classes";
import { teacherRouter } from "./teacher";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/student", studentRouter);
apiRouter.use("/exam", examRouter);
apiRouter.use("/admin/passages", passagesRouter);
apiRouter.use("/admin/audio", audioRouter);
apiRouter.use("/admin/question-groups", questionGroupsRouter);
apiRouter.use("/admin/questions", questionsRouter);
apiRouter.use("/admin/mock-tests", mockTestsRouter);
apiRouter.use("/admin/media", mediaRouter);
apiRouter.use("/admin/classes", classesRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/teacher", teacherRouter);
