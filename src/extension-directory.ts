// Optional discovery, not a registration requirement. Packages keep their own
// repositories/releases; an entry records the source a maintainer actually checked.
export const extensionDirectory = [
  {
    id: 'yulab.sclet', title: 'sclet', version: '0.1.0',
    description: 'State-aware single-cell analysis using sclet in your shared R Notebook.',
    source: 'git+https://github.com/YuLab-SMU/Rho-plugins.git#82df99f8cbab868c30949692172c6cf11db2f5c0:examples/sclet-plugin',
    repository: 'https://github.com/YuLab-SMU/Rho-plugins/tree/82df99f8cbab868c30949692172c6cf11db2f5c0/examples/sclet-plugin',
    needs: 'R, sclet, SingleCellExperiment and jsonlite in the selected R environment.',
  },
];
