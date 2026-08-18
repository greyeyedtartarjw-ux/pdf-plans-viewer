import { Router, type IRouter } from "express";
import healthRouter from "./health";
import documentsRouter from "./documents";
import annotationsRouter from "./annotations";
import measurementsRouter from "./measurements";
import sharesRouter from "./shares";

const router: IRouter = Router();

router.use(healthRouter);
router.use(documentsRouter);
router.use(annotationsRouter);
router.use(measurementsRouter);
router.use(sharesRouter);

export default router;
