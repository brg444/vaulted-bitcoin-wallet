//go:build connectorqualification

package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"

	emulatorv1 "github.com/arkade-os/emulator/api-spec/protobuf/gen/emulator/v1"
	"github.com/arkade-os/emulator/internal/application"
	"github.com/arkade-os/emulator/internal/interface/grpc/handlers"
	"github.com/meshapi/grpc-api-gateway/gateway"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func main() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	server := grpc.NewServer()
	emulatorv1.RegisterEmulatorServiceServer(server, handlers.New("v0.0.7", application.NewConnectorQualificationService()))
	go func() {
		if err := server.Serve(listener); err != nil {
			panic(err)
		}
	}()
	defer server.Stop()
	conn, err := grpc.NewClient(listener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		panic(err)
	}
	defer conn.Close()
	mux := gateway.NewServeMux()
	emulatorv1.RegisterEmulatorServiceHandler(context.Background(), mux, conn)
	web, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	origin := "http://" + web.Addr().String()
	if err := os.WriteFile("/tmp/vaulted-connector-emulator-origin", []byte(origin), 0600); err != nil {
		panic(err)
	}
	fmt.Println("Disposable connector qualification", origin)
	if err := http.Serve(web, mux); err != nil {
		panic(err)
	}
}
