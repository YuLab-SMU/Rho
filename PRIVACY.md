# Privacy and data handling

Rho currently contains application design and repository policies. An executable
application, application data store and model connection have not been implemented.
This document states the data boundaries that an accepted application must make
visible; it does not promise protections supplied by a running product.

## Data boundaries

Projects, native processes, component resources, editing buffers, Agent sessions
and application layout have different owners and lifetimes. Rho-core records
managed execution facts through its public capabilities. Rho-plugins owns each
component's inputs, native conditions, artifacts and domain checks. Rho owns
application coordination and presentation.

A selected component or service can retain content or send it elsewhere according
to its actual implementation and configuration. Consult
[Core](https://github.com/YuLab-SMU/Rho-core) and
[Plugins privacy](https://github.com/YuLab-SMU/Rho-plugins/blob/main/PRIVACY.md)
for those owner boundaries. Application-local storage does not make an external
model or service local.

## Requirements for application delivery

Before delivering a data-handling feature, document what it reads and writes,
where data and credentials live, network destinations, retention and removal,
and which owner controls each operation. Make model-provider and external-service
transfers visible for the selected flow. Do not treat closing a view, disconnecting
an observer or deleting layout as task cancellation or removal of project data.

Preserve acknowledged content and original task identity. Missing acknowledgements
and unavailable observations remain unknown outcomes. Queries are bounded
observation and must not start or recover a runtime. Resource references and
retrieved content do not expand project or caller scope.

Code, arguments, files, model context and diagnostics can contain private content
or credentials. Bounded output does not establish redaction. Keep secrets out of
source, public logs and shared evidence, and review evidence before sharing it.
Report suspected exposure through [Security](SECURITY.md).
