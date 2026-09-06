//go:build connectorqualification

package application

import (
	"encoding/hex"

	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
)

// NewConnectorQualificationService changes construction only: onchain parsing,
// policy execution, signature generation and HTTP/gRPC handlers are upstream.
// No network client or existing wallet is initialized; all keys are public fixtures.
func NewConnectorQualificationService() Service {
	key, _ := btcec.PrivKeyFromBytes([]byte{15})
	operator, _ := btcec.PrivKeyFromBytes([]byte{90})
	return &service{
		signer:        signer{secretKey: key},
		publicKey:     hex.EncodeToString(key.PubKey().SerializeCompressed()),
		arkdPubKey:    operator.PubKey(),
		computeLimits: arkade.DefaultComputeLimits(),
	}
}
