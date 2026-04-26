import { Scene as ThreeScene, FogExp2, Color, AmbientLight, DirectionalLight, BoxGeometry, MeshPhongMaterial, Mesh, PlaneGeometry, DoubleSide, GridHelper } from 'three';

export class Scene {
    constructor() {
        this.scene = new ThreeScene();
        this.scene.background = new Color(0x1a1a2e);
        this.scene.fog = new FogExp2(0x1a1a2e, 0.02);

        // Add ambient light
        const ambientLight = new AmbientLight(0x404040, 2);
        this.scene.add(ambientLight);

        // Add directional light
        const directionalLight = new DirectionalLight(0xffffff, 1);
        directionalLight.position.set(5, 10, 7);
        this.scene.add(directionalLight);

        // Add a simple cube
        const geometry = new BoxGeometry(2, 2, 2);
        const material = new MeshPhongMaterial({ 
            color: 0x4ecca3,
            emissive: 0x1a5c47,
            shininess: 100
        });
        const cube = new Mesh(geometry, material);
        cube.position.y = 1;
        this.scene.add(cube);

        // Add a ground plane
        const planeGeometry = new PlaneGeometry(50, 50);
        const planeMaterial = new MeshPhongMaterial({ 
            color: 0x16213e,
            side: DoubleSide
        });
        const plane = new Mesh(planeGeometry, planeMaterial);
        plane.rotation.x = -Math.PI / 2;
        plane.position.y = 0;
        this.scene.add(plane);

        // Add a grid helper
        const gridHelper = new GridHelper(50, 50, 0x4ecca3, 0x0f3460);
        this.scene.add(gridHelper);
    }

    get() {
        return this.scene;
    }
}