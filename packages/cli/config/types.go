package config

type Config struct {
	Name             string         `json:"name"`
	DistributionMode string         `json:"distribution_mode"`
	Infrastructure   Infrastructure `json:"infrastructure"`
	Build            Build          `json:"build"`
}

type Infrastructure struct {
	KubernetesHost  string          `json:"kubernetes_host"`
	S3Service       S3Service       `json:"s3_service"`
	DatabaseService DatabaseService `json:"database_service"`
	DockerRegistry  string          `json:"docker_registry"`
}

type S3Service struct {
	Endpoint  string `json:"endpoint"`
	Bucket    string `json:"bucket"`
	Region    string `json:"region"`
	AccessKey string `json:"access_key"`
	SecretKey string `json:"secret_key"`
	PublicURL string `json:"public_url"`
	UseSSL    bool   `json:"use_ssl"`
}

type DatabaseService struct {
	ConnectionString string `json:"connection_string"`
}

type Build struct {
	BaseImage string `json:"base_image"`
}
