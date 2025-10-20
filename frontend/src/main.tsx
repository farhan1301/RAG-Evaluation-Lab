
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { ExperimentResultsProvider } from "./state/experimentResults";
import { PipelineProvider } from "./state/pipelines";
import { DatasetProvider } from "./state/dataset";

createRoot(document.getElementById("root")!).render(
  <PipelineProvider>
    <DatasetProvider>
      <ExperimentResultsProvider>
        <App />
      </ExperimentResultsProvider>
    </DatasetProvider>
  </PipelineProvider>,
);
