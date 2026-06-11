import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chatRouter from "./chat";
import statsRouter from "./stats";
import historyRouter from "./history";
import keysRouter from "./keys";

const router: IRouter = Router();

router.use(healthRouter);
router.use(chatRouter);
router.use(statsRouter);
router.use(historyRouter);
router.use(keysRouter);

export default router;
