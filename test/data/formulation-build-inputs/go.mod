module example.com/formulation-inputs

go 1.22.2

toolchain go1.22.5

require (
	github.com/stretchr/testify v1.9.0
	golang.org/x/sys v0.21.0 // indirect
)

require golang.org/x/text v0.16.0

replace (
	golang.org/x/sys v0.21.0 => golang.org/x/sys v0.22.0
)

exclude (
	golang.org/x/net v0.20.0
)

retract v1.0.1 // published by mistake
